import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import JSON5 from "json5";
import { z } from "zod";

const ProcessString = z.string().refine((value) => !value.includes("\0"), "Must not contain NUL");
const Command = z.union([
  ProcessString,
  z
    .array(ProcessString)
    .min(1)
    .refine((args) => Boolean(args[0]?.length), "Executable must not be empty"),
]);
const Lifecycle = z.union([Command, z.record(z.string(), Command)]);
const Blob = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
const SecretName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const SecretRequests = z
  .record(
    SecretName,
    z
      .object({ description: z.string().optional(), documentationUrl: z.string().optional() })
      .passthrough(),
  )
  .refine((value) => Object.keys(value).length <= 16, "At most 16 setup secrets may be requested");
const Environment = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), ProcessString);
export const EnvironmentRecipeSchema = z
  .object({
    source: z.enum(["devcontainer", "script", "detected", "none"]),
    identity: Blob.optional(),
    inputs: z.record(z.string(), Blob),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), ProcessString.nullable()),
    secretNames: z.array(SecretName).max(16).optional(),
    ignoredPropertiesNote: z.string().optional(),
    onCreate: Lifecycle.optional(),
    updateContent: Lifecycle.optional(),
    postCreate: Lifecycle.optional(),
    postStart: Lifecycle.optional(),
    detectedInstall: Lifecycle.optional(),
  })
  .strict();
const Devcontainer = z
  .object({
    onCreateCommand: Lifecycle.optional(),
    updateContentCommand: Lifecycle.optional(),
    postCreateCommand: Lifecycle.optional(),
    postStartCommand: Lifecycle.optional(),
    secrets: SecretRequests.optional(),
    containerEnv: Environment.optional(),
    remoteEnv: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), ProcessString.nullable())
      .optional(),
  })
  .passthrough();

export type LifecycleCommand = z.infer<typeof Lifecycle>;
export type EnvironmentRecipeEntry = {
  blob: string;
  executable: boolean;
  content?: string;
};
export type EnvironmentRecipe = z.infer<typeof EnvironmentRecipeSchema>;

const supportedProperties = new Set([
  "onCreateCommand",
  "updateContentCommand",
  "postCreateCommand",
  "postStartCommand",
  "containerEnv",
  "secrets",
  "remoteEnv",
  "name",
  "$schema",
]);
const enableCorepack =
  'mkdir -p "$HOME/.local/bin" && corepack enable --install-directory "$HOME/.local/bin" && PATH="$HOME/.local/bin:$PATH"';

function parseDevcontainer(entry: EnvironmentRecipeEntry, file: string): EnvironmentRecipe {
  if (entry.content === undefined) {
    throw new Error(`Cannot read committed cloud environment file ${file}`);
  }
  const parsed = Devcontainer.safeParse(JSON5.parse<unknown>(entry.content));
  if (!parsed.success) {
    throw new Error(`Invalid cloud environment file ${file}: ${parsed.error.message}`);
  }
  const config = parsed.data;
  const ignored = Object.keys(config)
    .filter((property) => !supportedProperties.has(property))
    .toSorted();
  return {
    source: "devcontainer",
    identity: entry.blob,
    inputs: { [file]: entry.blob },
    env: { ...config.containerEnv, ...config.remoteEnv },
    secretNames: Object.keys(config.secrets ?? {}).toSorted(),
    ...(ignored.length
      ? { ignoredPropertiesNote: `devcontainer ${ignored.join(", ")} ignored on cloud machines` }
      : {}),
    ...(config.onCreateCommand !== undefined ? { onCreate: config.onCreateCommand } : {}),
    ...(config.updateContentCommand !== undefined
      ? { updateContent: config.updateContentCommand }
      : {}),
    ...(config.postCreateCommand !== undefined ? { postCreate: config.postCreateCommand } : {}),
    ...(config.postStartCommand !== undefined ? { postStart: config.postStartCommand } : {}),
  };
}

/** Repository declarations request operator-approved names, never grant secret access. */
export function assertEnvironmentRecipeSecretsMapped(
  recipe: EnvironmentRecipe | undefined,
  setupSecrets: unknown,
): void {
  const missing = recipe?.secretNames?.filter(
    (name) => !isRecord(setupSecrets) || !Object.hasOwn(setupSecrets, name),
  );
  if (missing?.length) {
    throw new Error(
      `Cloud environment requests unmapped setup secrets: ${missing.join(", ")}. Configure these names in the profile's settings.setupSecrets with protected store SecretRefs and allowed hosts before starting a session.`,
    );
  }
}

function yarnMajor(packageEntry: EnvironmentRecipeEntry | undefined): number | undefined {
  if (!packageEntry?.content) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(packageEntry.content);
    const parsed = z.object({ packageManager: z.string().optional() }).safeParse(value);
    const match = parsed.success
      ? parsed.data.packageManager?.match(/^yarn@(\d+)(?:[.+-]|$)/u)
      : null;
    return match ? Number(match[1]) : undefined;
  } catch {
    // Malformed package metadata belongs to the detected install's best-effort outcome.
    return undefined;
  }
}

/** Only committed inputs participate; uncommitted setup never enters a shared image. */
export async function resolveEnvironmentRecipe(
  readEntry: (file: string) => Promise<EnvironmentRecipeEntry | undefined>,
): Promise<EnvironmentRecipe> {
  for (const file of [".devcontainer/devcontainer.json", ".devcontainer.json"]) {
    const entry = await readEntry(file);
    if (entry) {
      return parseDevcontainer(entry, file);
    }
  }
  const scriptFile = ".openclaw/worktree-setup.sh";
  const script = await readEntry(scriptFile);
  if (script?.executable) {
    return {
      source: "script",
      identity: script.blob,
      inputs: { [scriptFile]: script.blob },
      env: {},
      onCreate: ["./.openclaw/worktree-setup.sh"],
    };
  }
  for (const file of [
    "pnpm-lock.yaml",
    "yarn.lock",
    "package-lock.json",
    "bun.lock",
    "bun.lockb",
  ]) {
    const lockfile = await readEntry(file);
    if (!lockfile) {
      continue;
    }
    const inputs: Record<string, string> = { [file]: lockfile.blob };
    const packageEntry = await readEntry("package.json");
    if (packageEntry) {
      inputs["package.json"] = packageEntry.blob;
    }
    let detectedInstall: LifecycleCommand;
    if (file === "pnpm-lock.yaml") {
      detectedInstall = `${enableCorepack} pnpm install --frozen-lockfile`;
    } else if (file === "yarn.lock") {
      const yarnConfig = await readEntry(".yarnrc.yml");
      if (yarnConfig) {
        inputs[".yarnrc.yml"] = yarnConfig.blob;
      }
      const major = yarnMajor(packageEntry);
      const berry = major !== undefined ? major >= 2 : yarnConfig !== undefined;
      detectedInstall = `${enableCorepack} yarn install ${berry ? "--immutable" : "--frozen-lockfile"}`;
    } else if (file === "package-lock.json") {
      detectedInstall = ["npm", "ci"];
    } else {
      detectedInstall =
        'if command -v bun >/dev/null 2>&1; then bun install --frozen-lockfile; else printf "%s\\n" "OpenClaw: bun install skipped because bun is not on PATH" >&2; fi';
    }
    return {
      source: "detected",
      identity: sha256Hex(
        JSON.stringify({
          version: 2,
          inputs: Object.entries(inputs).toSorted(([left], [right]) =>
            left.localeCompare(right, "en"),
          ),
        }),
      ),
      inputs,
      // Corepack auto-pinning must not rewrite the admitted package.json during detection.
      env:
        file === "pnpm-lock.yaml" || file === "yarn.lock"
          ? { COREPACK_ENABLE_AUTO_PIN: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" }
          : {},
      detectedInstall,
    };
  }
  return { source: "none", inputs: {}, env: {} };
}
