import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readOwnerAndDacl } from "@openclaw/fs-safe/permissions";
import { z } from "zod";
import { redactSensitiveArgv } from "../../config/redact-argv.js";
import type { OpenClawConfig } from "../../config/types.js";
import { OPENCLAW_WRAPPER_ENV_KEY } from "../../daemon/program-args.js";
import { isUpdateOwnedGatewayServiceCommand } from "../../daemon/service-update-authority.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import type { DaemonActionResponse } from "./response.js";
import { projectDaemonServiceForJson } from "./shared.js";
import type { DaemonStatus } from "./status.gather.js";
import type { DaemonInstallOptions } from "./types.js";

const MAX_RECEIPT_BYTES = 1024 * 1024;
const receiptOption = z.strictObject({ path: z.string().max(4096), nonce: z.uuid() });
const requestSchema = z.strictObject({
  runtime: z.literal("bun"),
  runtimePath: z.string().max(4096),
  expectedRuntimePin: z.strictObject({
    revision: z.string().min(1).max(4096),
    definition: z.string().min(1).max(4096),
  }),
});
const pendingSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("openclaw-desktop-runtime"),
  phase: z.literal("pending"),
  nonce: z.uuid(),
  request: requestSchema,
});
const INSTALL_FAILURE =
  "Gateway runtime installation failed. Inspect openclaw gateway status --deep before retrying; no automatic retry was attempted.";
const STALE_RUNTIME_PIN =
  "Gateway service or runtime pin changed before installation. The newer selection was preserved; inspect it before retrying.";
const INSTALL_CONFLICT =
  "Gateway service or runtime pin changed during installation. Inspect the current definition and runtime pin before retrying; no automatic retry was attempted.";
const OBSERVATION_FAILURE =
  "Gateway readiness could not be verified. Inspect openclaw gateway status --deep before retrying.";

const RECONCILIATION_OUTCOMES = [
  [
    "SERVICE_DEFINITION_UNKNOWN: Service definition inspection or backup failed; the definition was preserved: ",
    "left unchanged",
  ],
  [
    "SERVICE_DEFINITION_UNKNOWN: Service definition refresh failed; the previous definition was left unchanged: ",
    "left unchanged",
  ],
  [
    "SERVICE_DEFINITION_UNKNOWN: Service definition refresh failed; the previous definition was restored: ",
    "restored",
  ],
] as const;

function safeInstallFailure(message: string | undefined): string {
  let detail = message ?? "";
  let recovery: "restored" | "left unchanged" | undefined;
  for (let depth = 0; depth < 6; depth++) {
    if (
      detail === STALE_RUNTIME_PIN ||
      detail === "Runtime pin changed during service planning; rerun the install." ||
      detail === "Managed service changed during runtime pin planning; rerun the install." ||
      detail === "Gateway service definition changed during inspection."
    ) {
      return STALE_RUNTIME_PIN;
    }
    if (
      detail === "SERVICE_DEFINITION_UNKNOWN: Scheduled Task changed." ||
      detail.startsWith("SERVICE_DEFINITION_UNKNOWN: Service definition changed: ") ||
      detail ===
        "Runtime pin changed before persistence; service may have changed, rerun install with an explicit runtime selection." ||
      detail ===
        "Managed service readback differs from the runtime pin plan; pin metadata was not changed."
    ) {
      // A later conflict cannot attest that every service artifact stayed unchanged.
      return INSTALL_CONFLICT;
    }
    const reconciliation = RECONCILIATION_OUTCOMES.find(([prefix]) => detail.startsWith(prefix));
    const wrapper =
      reconciliation?.[0] ??
      ["Gateway install failed: ", "Error: "].find((prefix) => detail.startsWith(prefix));
    if (!wrapper) {
      return recovery
        ? `Gateway runtime installation failed. The previous service definition was ${recovery}. Inspect openclaw gateway status --deep before retrying; no automatic retry was attempted.`
        : INSTALL_FAILURE;
    }
    // Inner diagnostics cannot replace the enclosing owner's verified recovery outcome.
    recovery ??= reconciliation?.[1];
    detail = detail.slice(wrapper.length);
  }
  return INSTALL_FAILURE;
}

function rejectReceipt(): never {
  throw new Error("Invalid or changed desktop runtime receipt; no result was written.");
}

function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.ino !== 0n;
}

function inspectPrivatePath(target: string) {
  const facts = readOwnerAndDacl(target);
  if (
    facts.status !== "supported" ||
    !facts.isLocal ||
    !facts.daclPresent ||
    !facts.complete ||
    facts.unsupportedAceTypes.length !== 0 ||
    facts.ownerSid !== facts.currentUserSid
  ) {
    rejectReceipt();
  }
  const trusted = new Set([facts.currentUserSid, "s-1-5-18", "s-1-5-32-544"]);
  if (facts.aces.some((ace) => !ace.flags.inheritOnly && !trusted.has(ace.sid))) {
    rejectReceipt();
  }
}

function projectObservation(status: DaemonStatus) {
  const service = projectDaemonServiceForJson(status.service, { includeDefinitionPaths: false });
  const intent = service.runtimeIntent;
  return {
    service: {
      loaded: service.loaded,
      command: service.command
        ? {
            programArguments: redactSensitiveArgv(service.command.programArguments),
            workingDirectory: service.command.workingDirectory,
          }
        : null,
      runtimeIntent:
        intent?.status === "known"
          ? {
              status: intent.status,
              revision: intent.revision,
              definition: intent.definition,
              pin: intent.pin,
            }
          : { status: "unknown" },
      revision: service.revision,
      definitionMutation: service.definitionMutation,
      launcherOverridden: service.launcherOverridden,
      targetRole: service.targetRole,
      runtime: service.runtime
        ? { status: service.runtime.status, pid: service.runtime.pid }
        : undefined,
    },
    config: { daemon: { path: status.config?.daemon?.path }, mismatch: status.config?.mismatch },
    gateway: { port: status.gateway?.port },
    port: status.port
      ? {
          port: status.port.port,
          status: status.port.status,
          listeners: status.port.listeners.map(({ pid, ppid }) => ({ pid, ppid })),
        }
      : undefined,
    rpc: { ok: status.rpc?.ok === true },
  };
}

/** Evidence sink only: native service locks, pin CAS, and reconciliation own mutation admission. */
export function prepareDesktopRuntimeReceipt(opts: DaemonInstallOptions) {
  if (opts.desktopRuntimeReceipt === undefined) {
    return undefined;
  }
  if (
    process.platform !== "win32" ||
    opts.json !== true ||
    opts.force !== true ||
    opts.runtime !== "bun" ||
    !opts.runtimePath ||
    !path.win32.isAbsolute(opts.runtimePath) ||
    opts.expectedRuntimePin === undefined ||
    opts.restoreServiceCli !== undefined ||
    opts.wrapper !== undefined ||
    process.env[OPENCLAW_WRAPPER_ENV_KEY]?.trim() ||
    isUpdateOwnedGatewayServiceCommand() ||
    isTruthyEnvValue(process.env.OPENCLAW_UPDATE_IN_PROGRESS)
  ) {
    rejectReceipt();
  }
  const option = receiptOption.parse(JSON.parse(opts.desktopRuntimeReceipt));
  const request = requestSchema.parse({
    runtime: opts.runtime,
    runtimePath: opts.runtimePath,
    expectedRuntimePin: JSON.parse(opts.expectedRuntimePin),
  });
  // Account identity must not come from caller-controlled HOME/USERPROFILE overrides.
  const home = os.userInfo().homedir;
  const receiptRoot = path.join(home, ".openclaw", "desktop-runtime-actions");
  const actionDir = path.join(receiptRoot, option.nonce);
  if (!path.isAbsolute(home) || option.path !== path.join(actionDir, "result.json")) {
    rejectReceipt();
  }
  const ancestors: Array<{ name: string; identity: fs.BigIntStats }> = [];
  for (let name = path.dirname(option.path); ; name = path.dirname(name)) {
    const identity = fs.lstatSync(name, { bigint: true });
    if (!identity.isDirectory() || identity.isSymbolicLink() || identity.ino === 0n) {
      rejectReceipt();
    }
    if (fs.realpathSync.native(name).toLowerCase() !== name.toLowerCase()) {
      rejectReceipt();
    }
    ancestors.push({ name, identity });
    if (path.dirname(name) === name) {
      break;
    }
  }
  inspectPrivatePath(receiptRoot);
  inspectPrivatePath(actionDir);
  // Never create or truncate an unvalidated target, even when it has the expected name.
  const fd = fs.openSync(option.path, "r+");
  try {
    const identity = fs.fstatSync(fd, { bigint: true });
    const checkIdentity = () => {
      const opened = fs.fstatSync(fd, { bigint: true });
      const named = fs.lstatSync(option.path, { bigint: true });
      if (
        !opened.isFile() ||
        !named.isFile() ||
        named.isSymbolicLink() ||
        opened.nlink !== 1n ||
        !sameIdentity(identity, opened) ||
        !sameIdentity(opened, named)
      ) {
        rejectReceipt();
      }
      for (const ancestor of ancestors) {
        const current = fs.lstatSync(ancestor.name, { bigint: true });
        if (!current.isDirectory() || !sameIdentity(current, ancestor.identity)) {
          rejectReceipt();
        }
      }
      inspectPrivatePath(receiptRoot);
      inspectPrivatePath(actionDir);
      inspectPrivatePath(option.path);
      return opened;
    };
    const readPending = () => {
      const stat = checkIdentity();
      if (stat.size <= 0n || stat.size > BigInt(MAX_RECEIPT_BYTES)) {
        rejectReceipt();
      }
      const bytes = Buffer.alloc(Number(stat.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count === 0) {
          rejectReceipt();
        }
        offset += count;
      }
      if (fs.fstatSync(fd, { bigint: true }).size !== stat.size) {
        rejectReceipt();
      }
      return bytes;
    };
    const original = readPending();
    const pending = pendingSchema.parse(JSON.parse(original.toString("utf8")));
    if (
      pending.nonce !== option.nonce ||
      JSON.stringify(pending.request) !== JSON.stringify(request)
    ) {
      rejectReceipt();
    }
    let completed = false;
    let observation: ReturnType<typeof projectObservation> | null = null;
    let observationError: string | undefined;
    return {
      async observe(config: OpenClawConfig, port: number) {
        try {
          const { waitForGatewayDiagnosticReadiness } = await import("./diagnostic-readiness.js");
          await waitForGatewayDiagnosticReadiness({
            config,
            localPortOverride: port,
            ignoreEnvUrlOverride: true,
            serviceMode: "native",
            timeoutMs: 600_000,
          });
          const { gatherDaemonStatus } = await import("./status.gather.js");
          // A port override deliberately makes native status diagnostic-only.
          const status = await gatherDaemonStatus({
            rpc: {},
            probe: true,
            requireRpc: true,
            deep: true,
          });
          if (status.gateway?.port !== port) {
            throw new Error(OBSERVATION_FAILURE);
          }
          observation = projectObservation(status);
        } catch {
          observationError = OBSERVATION_FAILURE;
        }
      },
      emit(this: void, response: DaemonActionResponse) {
        if (response.action !== "install" || completed || !readPending().equals(original)) {
          rejectReceipt();
        }
        const payload = Buffer.from(
          JSON.stringify({
            ...pending,
            phase: "complete",
            install: {
              action: response.action,
              ok: response.ok,
              result: response.result,
              service: response.service,
              ...(response.ok ? {} : { error: safeInstallFailure(response.error) }),
            },
            observation: response.ok ? observation : null,
            ...(response.ok && observationError ? { observationError } : {}),
          }) + "\n",
        );
        if (payload.length > MAX_RECEIPT_BYTES) {
          rejectReceipt();
        }
        // Keep the admitted handle: the app holds the same file without delete sharing.
        let offset = 0;
        while (offset < payload.length) {
          const count = fs.writeSync(fd, payload, offset, payload.length - offset, offset);
          if (count === 0) {
            rejectReceipt();
          }
          offset += count;
        }
        fs.ftruncateSync(fd, payload.length);
        fs.fsyncSync(fd);
        completed = true;
      },
      close() {
        fs.closeSync(fd);
      },
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export type DesktopRuntimeReceipt = ReturnType<typeof prepareDesktopRuntimeReceipt>;
