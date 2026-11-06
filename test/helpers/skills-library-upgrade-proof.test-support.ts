import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  SkillsLibraryListResult,
  SkillsLibraryReadResult,
  SkillsLibraryReceipt,
} from "../../packages/gateway-protocol/src/schema/skill-library.ts";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.ts";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { verifyNpmRegistrySignatures } from "../../scripts/lib/npm-registry-signatures.mjs";
import { classifyReleaseTrain, parseReleaseVersion } from "../../scripts/lib/release-version.mjs";
import { resolveNpmRunner } from "../../scripts/npm-runner.mts";
import { OpenClawSchema } from "../../src/config/zod-schema.ts";
import { loadOrCreateDeviceIdentity } from "../../src/infra/device-identity.ts";
import {
  createGatewayProxy,
  gatewayProxyRoute,
} from "../../ui/src/e2e/gateway-proxy.test-support.ts";
import {
  digest,
  proofBinary,
  proofSkill,
  proofText,
  type createProofSource,
  type ImportProofReport,
} from "../../ui/src/e2e/skills-library-import-proof.test-support.ts";
import { acquireGatewayTestClient } from "./gateway-client.ts";
import { createOpenClawTestInstance, type OpenClawTestInstance } from "./openclaw-test-instance.ts";
import { runQaGatewayFixture } from "./qa-gateway-cleanup.ts";

const stableManifestSchema = z.object({
  version: z.string(),
  integrity: z.string(),
  packageSha256: z.string(),
  signatureVerified: z.literal(true),
  entrypoint: z.string(),
});
const npmSchema = z.object({
  version: z.string(),
  dist: z.object({
    integrity: z.string(),
    signatures: z.array(z.object({ keyid: z.string(), sig: z.string() })),
  }),
});
const keysSchema = z.object({ keys: z.array(z.object({ keyid: z.string(), key: z.string() })) });

function publicStableVersion(version: string) {
  return /^[0-9]{4}[.][0-9]+[.][0-9]+(?:-[0-9]+)?$/.test(version)
    ? version
    : "redacted-invalid-version";
}
function publicNpmDate(value: string | null) {
  if (value === "null" || value === "undefined" || value === "") {
    return null;
  }
  const timestamp = value === null ? Number.NaN : Date.parse(value.replace(/[.]$/u, ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "unavailable";
}
export function summarizeStableNpmPolicy(raw: {
  before: string | null;
  age: string | null;
  registry: string | null;
  version: string | null;
}) {
  let registryHost = "unavailable";
  if (raw.registry) {
    try {
      registryHost =
        new URL(raw.registry).hostname === "registry.npmjs.org"
          ? "registry.npmjs.org"
          : "non-default-registry";
    } catch {
      /* Never expose an invalid/private registry value. */
    }
  }
  return {
    before: publicNpmDate(raw.before),
    minReleaseAgeDays: raw.age !== null && /^[0-9]+$/u.test(raw.age) ? Number(raw.age) : null,
    registryHost,
    npmVersion:
      raw.version && /^[0-9]+[.][0-9]+[.][0-9]+$/u.test(raw.version) ? raw.version : "unavailable",
    queriesSucceeded: Object.values(raw).every((value) => value !== null),
  };
}
export function observeStableNpmPolicy(repository: string, root: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, npm_config_cache: path.join(root, "npm-cache") };
  const read = (args: string[]) => {
    const runner = resolveNpmRunner({ env, npmArgs: args });
    // Read-only queries cannot run package lifecycle scripts; retain the canonical runner/cwd/env.
    const result = spawnSync(runner.command, runner.args, {
      cwd: repository,
      env: runner.env ?? env,
      shell: runner.shell,
      windowsVerbatimArguments: runner.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 8192,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const policy = summarizeStableNpmPolicy({
    before: read(["config", "get", "before"]),
    age: read(["config", "get", "min-release-age"]),
    registry: read(["config", "get", "registry"]),
    version: read(["--version"]),
  });
  const environmentKeys = new Set(
    Object.keys(env).map((key) => key.toLowerCase().replaceAll("_", "-")),
  );
  return {
    ...policy,
    beforeFromEnvironment: environmentKeys.has("npm-config-before"),
    ageFromEnvironment: environmentKeys.has("npm-config-min-release-age"),
  };
}

export async function runStablePackageCommand(
  phase: "resolver" | "install",
  version: string,
  bin: string,
  args: string[],
  root: string,
  timeoutMs: number,
) {
  const log = await fs.open(path.join(root, "commands.private.log"), "a+", 0o600);
  const offset = (await log.stat()).size;
  const exit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
  let managedError = "";
  try {
    const status = await runManagedCommand({
      bin,
      args,
      cwd: root,
      env: { ...process.env, npm_config_cache: path.join(root, "npm-cache") },
      stdio: ["ignore", log.fd, log.fd],
      timeoutMs,
      requireProcessTreeExit: true,
      onReady: (child) => {
        child.once("exit", (code, signal) => {
          exit.code = code;
          exit.signal = signal;
        });
      },
    }).catch((error: unknown) => {
      managedError = error instanceof Error ? error.message : "";
      return null;
    });
    if (status === 0) {
      return;
    }
    const size = (await log.stat()).size;
    const tail = Buffer.alloc(Math.min(16384, size - offset));
    const { bytesRead } = await log.read(tail, 0, tail.length, size - tail.length);
    const privateOutput = tail.subarray(0, bytesRead).toString("utf8") + managedError;
    const code =
      [
        "ERR_MODULE_NOT_FOUND",
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
        "E401",
        "E403",
        "E404",
        "ETARGET",
        "ENOTFOUND",
        "ECONNRESET",
        "ETIMEDOUT",
        "EINTEGRITY",
        "EINVALIDSIGNATURE",
        "EUSAGE",
        "EACCES",
        "ENOENT",
        "ENOSPC",
      ].find((value) => privateOutput.includes(value)) ?? null;
    const target = "No matching version found for openclaw@" + version;
    const etargetMatchesRoot =
      code === "ETARGET"
        ? privateOutput.includes(target + " ") || privateOutput.includes(target + ".")
        : null;
    const before = privateOutput.match(/with a date before ([^\r\n]+)/u)?.[1]?.trim();
    const reportedBefore = before ? publicNpmDate(before) : null;
    // Only enum/scalar facts leave the private log; never emit command arguments or child output.
    const classification = privateOutput.includes("package tarball integrity failed")
      ? privateOutput.includes(" imports missing ")
        ? "tarball-missing-relative-import"
        : "tarball-integrity"
      : code
        ? "known-npm-or-runtime-code"
        : "unclassified-private-output";
    const diagnostic =
      "Owned stable-package command failed: " +
      JSON.stringify({
        phase,
        version: publicStableVersion(version),
        status,
        exit: exit.code,
        signal: exit.signal,
        code,
        etargetMatchesRoot,
        reportedBefore,
        classification,
      });
    console.error(diagnostic);
    throw new Error(diagnostic);
  } finally {
    await log.close();
  }
}

export async function prepareStablePackage() {
  if (process.env.GITHUB_ACTIONS !== "true" || !process.env.PROOF_STABLE_MANIFEST) {
    throw new Error("Stable qualification requires the disposable proof workflow");
  }
  const manifestPath = process.env.PROOF_STABLE_MANIFEST;
  const root = path.dirname(manifestPath);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const metadata = npmSchema.parse(
    await fetch("https://registry.npmjs.org/openclaw/latest").then((response) => {
      if (!response.ok) {
        throw new Error("Stable registry metadata unavailable");
      }
      return response.json();
    }),
  );
  const version = parseReleaseVersion(metadata.version);
  if (!version || classifyReleaseTrain(version) !== "stable") {
    throw new Error("npm latest is not the stable train");
  }
  const keys = keysSchema.parse(
    await fetch("https://registry.npmjs.org/-/npm/v1/keys").then((response) => response.json()),
  );
  verifyNpmRegistrySignatures({
    packageName: "openclaw",
    version: metadata.version,
    integrity: metadata.dist.integrity,
    signatures: metadata.dist.signatures,
    keys: keys.keys,
  });
  const repository = process.cwd();
  console.info(
    "Stable npm selection policy: " +
      JSON.stringify({
        ...observeStableNpmPolicy(repository, root),
        requestedVersion: publicStableVersion(metadata.version),
      }),
  );
  const output = path.join(root, "package-output");
  await runStablePackageCommand(
    "resolver",
    metadata.version,
    process.execPath,
    [
      "--import",
      path.join(repository, "scripts/tsx.mjs"),
      path.join(repository, "scripts/resolve-openclaw-package-candidate.mts"),
      "--source",
      "npm",
      "--package-spec",
      "openclaw@" + metadata.version,
      "--output-dir",
      path.join(root, "package"),
      "--github-output",
      output,
    ],
    root,
    180000,
  );
  const facts = Object.fromEntries(
    (await fs.readFile(output, "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  if (facts.package_version !== metadata.version || !facts.tarball) {
    throw new Error("Pinned stable package identity changed");
  }
  const tarball = await fs.readFile(facts.tarball);
  const integrity = "sha512-" + createHash("sha512").update(tarball).digest("base64");
  if (integrity !== metadata.dist.integrity) {
    throw new Error("Stable archive integrity mismatch");
  }
  const packageSha256 = digest(tarball);
  if (packageSha256 !== facts.sha256) {
    throw new Error("Stable resolver hash mismatch");
  }
  const prefix = path.join(root, "installed");
  await runStablePackageCommand(
    "install",
    metadata.version,
    "npm",
    ["install", "--prefix", prefix, "--no-audit", "--no-fund", facts.tarball],
    root,
    600000,
  );
  const entrypoint = path.join(prefix, "node_modules/openclaw/openclaw.mjs");
  await fs.access(entrypoint);
  const manifest = stableManifestSchema.parse({
    version: metadata.version,
    integrity,
    packageSha256,
    signatureVerified: true,
    entrypoint,
  });
  await fs.writeFile(manifestPath, JSON.stringify(manifest) + "\n", { mode: 0o600 });
  console.log(
    "Verified actual npm latest stable package identity and integrity for isolated proof.",
  );
}

async function authenticatedClient(instance: OpenClawTestInstance, email: string, root: string) {
  const proxy = await createGatewayProxy(root, { "/": gatewayProxyRoute(instance.port, email) });
  await proxy.listen();
  const address = proxy.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Stable proof auth proxy unavailable");
  }
  try {
    const client = await acquireGatewayTestClient(
      {
        url: "ws://127.0.0.1:" + address.port,
        clientName: "test",
        mode: "test",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        deviceIdentity: loadOrCreateDeviceIdentity({
          env: instance.env,
          identityKey: "skills-upgrade-proof-client",
        }),
      },
      {
        timeoutMs: 15000,
        timeoutMessage: "Stable proof profile authentication failed",
        closeMessage: "Stable proof transport closed",
      },
    );
    return {
      client,
      close: async () => {
        await client.stopAndWait();
        await proxy.close();
      },
    };
  } catch (error) {
    await proxy.close();
    throw error;
  }
}

async function stateHash(stateDir: string, configPath: string) {
  const records: string[] = [];
  async function walk(directory: string, prefix: string) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = path.join(directory, entry.name);
      const name = prefix + entry.name;
      if (entry.isDirectory()) {
        await walk(file, name + "/");
      } else if (entry.isSymbolicLink()) {
        records.push(name + ":link:" + (await fs.readlink(file)));
      } else {
        records.push(name + ":" + digest(await fs.readFile(file)));
      }
    }
  }
  await walk(stateDir, "state/");
  records.push("config:" + digest(await fs.readFile(configPath)));
  return digest(records.join("\n"));
}
function readFingerprint(read: SkillsLibraryReadResult) {
  return digest(
    JSON.stringify({
      content: digest(read.content),
      files: read.files
        .map((file) => ({
          path: file.path,
          hash: digest(
            file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content,
          ),
          executable: file.executable === true,
        }))
        .toSorted((a, b) => a.path.localeCompare(b.path)),
    }),
  );
}
function requireTrue(condition: unknown, stage: string): asserts condition {
  if (!condition) {
    throw new Error("Stable skill survival failed at " + stage);
  }
}

export async function proveStableSkillUpgrade(options: {
  source: Awaited<ReturnType<typeof createProofSource>>;
  caCert: string;
  expectedHead: string;
  signal: AbortSignal;
  onStage: (stage: string) => void;
}): Promise<NonNullable<ImportProofReport["upgrade"]>> {
  if (process.env.GITHUB_ACTIONS !== "true" || !process.env.PROOF_STABLE_MANIFEST) {
    throw new Error("Stable proof fixture is not qualified");
  }
  options.onStage("stable-package-qualified");
  const candidateBuild = z
    .object({ commit: z.string() })
    .parse(JSON.parse(await fs.readFile("dist/build-info.json", "utf8")));
  requireTrue(candidateBuild.commit === options.expectedHead, "exact-candidate-build-head");
  const stablePackage = stableManifestSchema.parse(
    JSON.parse(await fs.readFile(process.env.PROOF_STABLE_MANIFEST, "utf8")),
  );
  const raw = path.join(path.dirname(process.env.PROOF_STABLE_MANIFEST), "state-survival");
  await fs.mkdir(raw, { recursive: true, mode: 0o700 });
  const workspace = path.join(raw, "workspace");
  await fs.mkdir(path.join(workspace, "skills/legacy-proof"), { recursive: true });
  const legacy =
    "---\nname: legacy-proof\ndescription: Synthetic legacy skill\n---\n# Legacy procedure\n";
  await fs.writeFile(path.join(workspace, "skills/legacy-proof/SKILL.md"), legacy);
  const email = randomUUID() + "@example.test";
  const config = {
    agents: {
      defaults: { workspace, model: { primary: "fixture/no-model" } },
      entries: { main: {} },
    },
    update: { checkOnStart: false },
    gateway: {
      controlUi: { enabled: false },
      trustedProxies: ["127.0.0.1", "::1"],
      auth: {
        mode: "trusted-proxy",
        token: undefined,
        trustedProxy: {
          allowLoopback: true,
          allowUsers: [email],
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          deviceAutoApprove: {
            enabled: true,
            scopes: ["operator.admin", "operator.read", "operator.write"],
          },
        },
      },
    },
    skills: {
      entries: { "preserved-disabled": { enabled: false } },
      load: { watch: false },
      install: { preferBrew: false, nodeManager: "npm" },
    },
  };
  const env = {
    NODE_EXTRA_CA_CERTS: options.caCert,
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
  };
  const stable = await createOpenClawTestInstance({
    name: "skill-proof-stable",
    entrypoint: [stablePackage.entrypoint],
    config,
    env,
    signal: options.signal,
  });
  let candidate: OpenClawTestInstance | undefined;
  return runQaGatewayFixture(
    async () => {
      options.onStage("stable-start");
      await stable.startGateway();
      const transport = await authenticatedClient(stable, email, raw);
      let first: SkillsLibraryReceipt;
      let second: SkillsLibraryReceipt;
      let firstHash: string;
      let secondHash: string;
      try {
        const actor = await transport.client.request<SkillsLibraryListResult>(
          "skills.library.list",
          {},
        );
        requireTrue(
          actor.profileId && actor.profileId !== GATEWAY_OWNER_PROFILE_ID,
          "stable-real-personal-profile",
        );
        const files = [
          { path: "references/checklist.md", content: proofText, encoding: "utf8" as const },
          {
            path: "assets/sample.bin",
            content: proofBinary.toString("base64"),
            encoding: "base64" as const,
          },
        ];
        const firstContent =
          "---\nname: stable-proof\ndescription: Stable synthetic procedure\n---\n# First revision\n";
        const secondContent =
          "---\nname: stable-proof\ndescription: Stable synthetic procedure\n---\n# Second revision\n";
        options.onStage("stable-two-revisions");
        first = await transport.client.request<SkillsLibraryReceipt>("skills.library.save", {
          slug: "stable-proof",
          expectedRevision: null,
          content: firstContent,
          files,
        });
        second = await transport.client.request<SkillsLibraryReceipt>("skills.library.save", {
          slug: "stable-proof",
          skillId: first.entry.skillId,
          expectedRevision: first.entry.revision,
          content: secondContent,
          files,
        });
        requireTrue(
          first.entry.ownerProfileId === actor.profileId &&
            second.entry.ownerProfileId === actor.profileId,
          "stable-owner",
        );
        requireTrue(first.entry.skillId === second.entry.skillId, "stable-same-skill-id");
        requireTrue(first.entry.revision !== second.entry.revision, "stable-distinct-revisions");
        const qualifiedReads: SkillsLibraryReadResult[] = [];
        for (const [receipt, expectedContent] of [
          [first, firstContent],
          [second, secondContent],
        ] as const) {
          const read = await transport.client.request<SkillsLibraryReadResult>(
            "skills.library.read",
            {
              skillId: receipt.entry.skillId,
              revision: receipt.entry.revision,
            },
          );
          requireTrue(
            read.entry.skillId === first.entry.skillId &&
              read.entry.revision === receipt.entry.revision &&
              read.entry.ownerProfileId === actor.profileId,
            "stable-read-identity",
          );
          requireTrue(read.content === expectedContent, "stable-expected-skill-bytes");
          const expectedFiles = files;
          requireTrue(
            JSON.stringify(read.files.map((file) => file.path).toSorted()) ===
              JSON.stringify(expectedFiles.map((file) => file.path).toSorted()),
            "stable-complete-file-manifest",
          );
          for (const expectedFile of expectedFiles) {
            const actual = read.files.find((file) => file.path === expectedFile.path);
            requireTrue(
              actual &&
                actual.encoding === expectedFile.encoding &&
                actual.content === expectedFile.content &&
                actual.executable !== true,
              "stable-expected-companion-bytes-and-mode",
            );
          }
          qualifiedReads.push(read);
        }
        const [firstRead, secondRead] = qualifiedReads;
        requireTrue(firstRead && secondRead, "stable-both-qualified-revisions");
        firstHash = readFingerprint(firstRead);
        secondHash = readFingerprint(secondRead);
      } finally {
        await transport.close();
      }
      await stable.stopGateway();
      const original = await stateHash(stable.state.stateDir, stable.state.configPath);
      options.onStage("copy-clean-stable-state");
      candidate = await createOpenClawTestInstance({
        name: "skill-proof-candidate",
        config,
        env,
        signal: options.signal,
      });
      await fs.cp(stable.state.stateDir, candidate.state.stateDir, {
        recursive: true,
        force: true,
      });
      await fs.copyFile(stable.state.configPath, candidate.state.configPath);
      options.onStage("candidate-doctor");
      const doctor = await candidate.cli(["doctor", "--fix", "--non-interactive"]);
      requireTrue(doctor.code === 0, "candidate-normal-doctor");
      await candidate.startGateway();
      options.onStage("candidate-survival");
      let current = await authenticatedClient(candidate, email, raw);
      let firstAfter = "";
      let secondAfter = "";
      try {
        const entries = await current.client.request<SkillsLibraryListResult>(
          "skills.library.list",
          {},
        );
        const entry = entries.entries.find((value) => value.skillId === second.entry.skillId);
        requireTrue(
          entry?.revision === second.entry.revision &&
            entry.ownerProfileId === second.entry.ownerProfileId,
          "candidate-owner-and-current-revision",
        );
        firstAfter = readFingerprint(
          await current.client.request<SkillsLibraryReadResult>("skills.library.read", {
            skillId: first.entry.skillId,
            revision: first.entry.revision,
          }),
        );
        secondAfter = readFingerprint(
          await current.client.request<SkillsLibraryReadResult>("skills.library.read", {
            skillId: second.entry.skillId,
            revision: second.entry.revision,
          }),
        );
        requireTrue(firstAfter === firstHash && secondAfter === secondHash, "both-revision-bytes");
        const status = await current.client.request<{ skills: Array<{ name: string }> }>(
          "skills.status",
          { agentId: "main" },
        );
        requireTrue(
          status.skills.some((value) => value.name === "legacy-proof"),
          "legacy-skill-usable",
        );
      } finally {
        await current.close();
      }
      await candidate.stopGateway();
      const persisted = OpenClawSchema.parse(
        JSON.parse(await fs.readFile(candidate.state.configPath, "utf8")),
      );
      requireTrue(
        persisted.skills?.entries?.["preserved-disabled"]?.enabled === false &&
          persisted.skills?.load?.watch === false &&
          persisted.skills?.install?.preferBrew === false &&
          persisted.skills?.install?.nodeManager === "npm",
        "settings-preserved",
      );
      const settingsBefore = digest(
        JSON.stringify({
          entries: persisted.skills?.entries,
          load: persisted.skills?.load,
          install: persisted.skills?.install,
        }),
      );
      requireTrue(
        persisted.skills?.library?.import?.allowedOrigins === undefined,
        "new-setting-absent-after-stable-survival",
      );
      await candidate.state.writeConfig({
        ...persisted,
        skills: {
          ...persisted.skills,
          library: { import: { allowedOrigins: [options.source.origin] } },
        },
      });
      options.onStage("candidate-new-url-import");
      await candidate.startGateway();
      current = await authenticatedClient(candidate, email, raw);
      try {
        const requestsBefore = options.source.count("/after-upgrade.zip");
        const imported = await current.client.request<SkillsLibraryReceipt>(
          "skills.library.import",
          {
            slug: "after-upgrade",
            source: {
              kind: "url",
              url: options.source.origin + "/after-upgrade.zip",
              path: "skills/proof",
            },
          },
        );
        requireTrue(
          imported.entry.ownerProfileId === second.entry.ownerProfileId,
          "new-import-owned-by-surviving-profile",
        );
        requireTrue(
          imported.entry.slug === "after-upgrade" &&
            imported.entry.skillId !== second.entry.skillId,
          "new-import-distinct-publication",
        );
        requireTrue(
          options.source.count("/after-upgrade.zip") === requestsBefore + 1,
          "new-import-real-https-transport",
        );
        const newRead = await current.client.request<SkillsLibraryReadResult>(
          "skills.library.read",
          { skillId: imported.entry.skillId },
        );
        requireTrue(digest(newRead.content) === digest(proofSkill), "new-import-content");
        requireTrue(
          newRead.files.some(
            (file) =>
              file.path === "references/checklist.md" && digest(file.content) === digest(proofText),
          ),
          "new-import-text-companion",
        );
        requireTrue(
          newRead.files.some(
            (file) =>
              file.path === "assets/sample.bin" &&
              digest(Buffer.from(file.content, "base64")) === digest(proofBinary),
          ),
          "new-import-binary-companion",
        );
        firstAfter = readFingerprint(
          await current.client.request<SkillsLibraryReadResult>("skills.library.read", {
            skillId: first.entry.skillId,
            revision: first.entry.revision,
          }),
        );
        secondAfter = readFingerprint(
          await current.client.request<SkillsLibraryReadResult>("skills.library.read", {
            skillId: second.entry.skillId,
            revision: second.entry.revision,
          }),
        );
        requireTrue(
          firstAfter === firstHash && secondAfter === secondHash,
          "both-existing-revisions-after-new-import",
        );
      } finally {
        await current.close();
      }
      await candidate.stopGateway();
      const finalConfig = OpenClawSchema.parse(
        JSON.parse(await fs.readFile(candidate.state.configPath, "utf8")),
      );
      const settingsAfter = digest(
        JSON.stringify({
          entries: finalConfig.skills?.entries,
          load: finalConfig.skills?.load,
          install: finalConfig.skills?.install,
        }),
      );
      requireTrue(settingsAfter === settingsBefore, "existing-settings-after-new-import");
      const originalAfter = await stateHash(stable.state.stateDir, stable.state.configPath);
      requireTrue(originalAfter === original, "original-state-untouched");
      requireTrue(
        digest(await fs.readFile(path.join(workspace, "skills/legacy-proof/SKILL.md"))) ===
          digest(legacy),
        "legacy-file-unchanged",
      );
      return {
        version: stablePackage.version,
        integrity: stablePackage.integrity,
        packageSha256: stablePackage.packageSha256,
        signatureVerified: true,
        preserved: true,
        originalUnchanged: true,
        revisions: [first.entry.revision, second.entry.revision],
        revisionHashesBefore: [firstHash, secondHash],
        revisionHashesAfter: [firstAfter, secondAfter],
        originalStateHashBefore: original,
        originalStateHashAfter: originalAfter,
        settingsPreserved: true,
        settingsHashBefore: settingsBefore,
        settingsHashAfter: settingsAfter,
        legacySkillPreserved: true,
        doctorSucceeded: true,
        newImportSucceeded: true,
      };
    },
    async () => candidate?.stopGateway(),
    () => stable.stopGateway(),
    async () => candidate?.cleanup(),
    () => stable.cleanup(),
  );
}
