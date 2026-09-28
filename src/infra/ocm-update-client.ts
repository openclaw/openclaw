import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { z } from "zod";
import {
  createConfigRuntimeEnvBase,
  getPublishedConfigRuntimeEnvState,
} from "../config/config-env-vars.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { redactKnownPathPrefixesForSupport } from "../logging/diagnostic-support-redaction.js";
import { redactSensitiveText } from "../logging/redact.js";
import { isPlainCommandExitFailure, runExec } from "../process/exec.js";
import { formatErrorMessage } from "./errors.js";
import type { UpdateChannel } from "./update-channels.js";
import type { UpdateRunRecord } from "./update-run-record.js";

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const jobId = name.max(128);
const timestamp = z.string().transform(Date.parse).pipe(z.number().int().nonnegative());
const commandFailureSchema = z.object({
  failed: z.boolean(),
  exitCode: z.number().optional(),
  signal: z.unknown().optional(),
  cause: z.unknown().optional(),
  timedOut: z.boolean().optional(),
  isCanceled: z.boolean().optional(),
  isMaxBuffer: z.boolean().optional(),
  isTerminated: z.boolean().optional(),
  stdout: z.string(),
  stderr: z.string(),
});

export class OcmUpdateCapabilitiesUnsupportedError extends Error {
  constructor() {
    super(
      "OCM update capabilities are unsupported. Use OCM's update command or update OCM to enable Gateway update jobs.",
    );
  }
}

const capabilitySchema = z.object({
  protocol: z.literal("ocm.upgrade-job"),
  protocolVersion: z.literal(1),
  supported: z.boolean(),
  envName: name,
  envRoot: z.string(),
  stateDir: z.string(),
  configPath: z.string(),
  bindingKind: z.enum(["runtime", "launcher", "dev", "none"]),
  bindingName: name.optional(),
  operations: z.array(z.string()),
  selectors: z.array(z.string()),
});
const jobSchema = z.object({
  id: jobId,
  envName: name,
  state: z.enum(["starting", "running", "succeeded", "failed", "interrupted"]),
  progress: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  result: z
    .object({
      outcome: z.string(),
      bindingKind: z.string().optional(),
      runtimeReleaseVersion: z.string().nullable(),
      note: z.string().nullable(),
    })
    .nullable(),
  error: z.string().nullable(),
});

function projectJob(
  job: z.infer<typeof jobSchema>,
  redact: (value: string) => string,
): UpdateRunRecord {
  const running = job.state === "starting" || job.state === "running";
  const current = job.result?.outcome === "up-to-date";
  const changed =
    job.result?.outcome === "updated" ||
    job.result?.outcome === "switched" ||
    job.result?.outcome === "source-updated";
  // A later rebind cannot change the outcome or target of a recorded update.
  const kind =
    job.result?.bindingKind === "runtime"
      ? "package"
      : job.result?.bindingKind === "launcher"
        ? "git"
        : undefined;
  const status = running
    ? "running"
    : job.result?.outcome === "rolled-back"
      ? "rolled-back"
      : job.state !== "succeeded"
        ? "failed"
        : changed
          ? "succeeded"
          : "skipped";
  const failed = status === "failed" || status === "rolled-back";
  const version = job.result?.runtimeReleaseVersion
    ? redact(job.result.runtimeReleaseVersion)
    : undefined;
  return {
    runId: `ocm:${job.id}`,
    createdAtMs: job.createdAt,
    updatedAtMs: job.updatedAt,
    trigger: "api",
    phase: running ? "requested" : "finished",
    status,
    reason: current
      ? "already-current"
      : failed
        ? `ocm-update-${job.state}`
        : status === "skipped"
          ? `ocm-${job.result?.outcome ?? "unknown-outcome"}`
          : null,
    origin:
      failed || running || status === "skipped"
        ? {
            nextAction: `OCM owns this update. Check its status with ocm upgrade job status ${job.envName} --request-id ${job.id}.`,
          }
        : {},
    target: {
      ...(kind ? { kind } : {}),
      installationMethod: "ocm",
      ...(version ? { version } : {}),
    },
    before: {},
    after: status === "succeeded" && version ? { version } : {},
    steps: [
      {
        step: "OCM update",
        status: running
          ? "in_progress"
          : failed
            ? "failed"
            : status === "skipped"
              ? "skipped"
              : "completed",
        startedAtMs: job.createdAt,
        ...(running ? {} : { endedAtMs: job.updatedAt }),
        detail: redact(job.error ?? job.result?.note ?? job.progress),
      },
    ],
    verification: {},
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: running ? null : job.updatedAt,
    downtimeMs: null,
  };
}

/** OCM launch metadata selects the manager; an RPC can select only a recorded job ID. */
export async function resolveOcmUpdateManager() {
  const published = getPublishedConfigRuntimeEnvState();
  // Config env belongs to OpenClaw; it cannot select the manager or its host tools.
  const env = published.sourceConfig
    ? createConfigRuntimeEnvBase(published.sourceConfig, process.env, {
        ownedEnv: published.ownedEnv,
      })
    : { ...process.env };
  // Env activation alone is not supervision; require the manager and environment identity.
  if (!env.OCM_SELF || (!env.OCM_ACTIVE_ENV && !env.OCM_ACTIVE_ENV_ROOT)) {
    return null;
  }
  const redaction = { env, stateDir: resolveStateDir(env) };
  const redact = (value: string) =>
    truncateUtf16Safe(
      redactKnownPathPrefixesForSupport(redactSensitiveText(value, { mode: "tools" }), redaction),
      1024,
    );
  const rejectDiagnostic = (error: unknown): never => {
    throw new Error(redact(formatErrorMessage(error)));
  };
  const executable = env.OCM_SELF;
  const envName = name.safeParse(env.OCM_ACTIVE_ENV);
  const root = env.OCM_ACTIVE_ENV_ROOT;
  if (
    !executable ||
    !path.isAbsolute(executable) ||
    !env.OCM_HOME ||
    !path.isAbsolute(env.OCM_HOME) ||
    !root ||
    !path.isAbsolute(root) ||
    !envName.success
  ) {
    throw new Error("The OCM update binding is incomplete. Restart this environment through OCM.");
  }
  const command = async (args: string[]) => {
    const { stdout } = await runExec(executable, ["upgrade", "job", ...args, "--json"], {
      baseEnv: env,
      timeoutMs: 30_000,
      maxBuffer: 64 * 1024,
      logOutput: false,
    }).catch((error: unknown) => {
      const failure = commandFailureSchema.safeParse(error);
      // Released managers reject this command before looking up or updating an environment.
      if (
        args[0] === "capabilities" &&
        failure.success &&
        isPlainCommandExitFailure(failure.data) &&
        failure.data.exitCode === 1 &&
        failure.data.stdout === "" &&
        failure.data.stderr ===
          `ocm: unexpected arguments: capabilities ${envName.data}\nRun "${executable.trim()} help" for usage.\n`
      ) {
        throw new OcmUpdateCapabilitiesUnsupportedError();
      }
      return rejectDiagnostic(error);
    });
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      throw new Error("OCM returned an invalid update response.");
    }
  };
  const parsedCapability = capabilitySchema.safeParse(
    await command(["capabilities", envName.data]).catch((error: unknown) => {
      if (error instanceof OcmUpdateCapabilitiesUnsupportedError) {
        throw error;
      }
      throw new Error(
        `Could not read OCM update capabilities: ${formatErrorMessage(error)}. Use OCM's update command or update OCM to enable Gateway update jobs.`,
      );
    }),
  );
  if (!parsedCapability.success) {
    throw new Error("OCM returned an unsupported update capability response.");
  }
  const capability = parsedCapability.data;
  const pairs: Array<readonly [string, string]> = [
    [capability.envRoot, root],
    [capability.stateDir, resolveStateDir(env)],
    [capability.configPath, resolveConfigPath(env)],
  ];
  const matches = await Promise.all(
    pairs.map(
      async ([actual, expected]) =>
        path.isAbsolute(actual) &&
        (await fs.realpath(actual).catch(rejectDiagnostic)) ===
          (await fs.realpath(expected).catch(rejectDiagnostic)),
    ),
  );
  if (capability.envName !== envName.data || matches.some((match) => !match)) {
    throw new Error("OCM's update binding does not match this Gateway's state and configuration.");
  }
  const kind =
    capability.bindingKind === "runtime"
      ? "package"
      : capability.bindingKind === "launcher"
        ? "git"
        : null;
  if (!capability.supported || !capability.bindingName) {
    return null;
  }
  const read = (value: unknown, id?: string) => {
    const parsedJob = jobSchema.safeParse(value);
    if (!parsedJob.success) {
      throw new Error("OCM returned an invalid update status. Inspect the job through OCM.");
    }
    const job = parsedJob.data;
    if (job.envName !== envName.data || (id !== undefined && job.id !== id)) {
      throw new Error("OCM returned an update for a different environment or request.");
    }
    return projectJob(job, redact);
  };
  return {
    // An accepted job remains readable while its source cannot admit another update.
    canStart:
      kind !== null &&
      capability.operations.includes(kind === "package" ? "packaged-upgrade" : "source-upgrade"),
    async start(assertCurrent: () => void, channel?: UpdateChannel | null) {
      if (
        (kind === "package" && channel === "dev") ||
        (channel && kind === "package" && !capability.selectors.includes("channel"))
      ) {
        throw new Error(
          "OCM cannot apply the selected update channel while preserving this installation type.",
        );
      }
      const id = randomUUID();
      assertCurrent();
      try {
        return read(
          await command([
            "start",
            envName.data,
            "--request-id",
            id,
            "--if-binding",
            `${capability.bindingKind}:${capability.bindingName}`,
            // Native source updates read the channel from OpenClaw's configuration.
            ...(channel && kind === "package" ? ["--channel", channel] : []),
          ]),
          id,
        );
      } catch (error) {
        // A lost reply does not prove rejection. Reconcile this request without resubmitting it.
        try {
          return read(await command(["status", envName.data, "--request-id", id]), id);
        } catch {
          throw error;
        }
      }
    },
    async status(runId?: string) {
      const id = runId === undefined ? undefined : jobId.parse(runId.replace(/^ocm:/u, ""));
      const value = await command(["status", envName.data, ...(id ? ["--request-id", id] : [])]);
      return value === null && id === undefined ? null : read(value, id);
    },
  };
}
