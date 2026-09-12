// Independent startup validation. Agent output and Doctor findings are not this oracle.
import { z } from "zod";
import {
  confirmGatewayReachable,
  waitForGatewayHttpReadiness,
} from "../cli/daemon-cli/restart-health-probe.js";
import { createConfigIO } from "../config/io.js";
import { resolveGatewayPort } from "../config/paths.js";
import { resolveGatewayProbeAuthSafeWithSecretInputs } from "../gateway/probe-auth.js";
import type { TriageBackingReference } from "../infra/triage-backing.js";
import type { TriageFailureContext } from "./triage-prompt.js";

const validationSchema = z
  .strictObject({
    ok: z.boolean(),
    port: z.number().int().positive().max(65535),
    bootId: z.string().min(1).max(256).optional(),
    version: z.string().min(1).max(100).optional(),
    summary: z.enum(["startup-verified", "startup-unhealthy", "startup-unavailable"]),
  })
  .refine(
    (value) =>
      !value.ok || Boolean(value.bootId && value.version && value.summary === "startup-verified"),
  );
const failureSchema = z.strictObject({
  kind: z.enum(["update", "gateway-startup"]),
  phase: z.string().max(120),
  gateway: z.literal("verify-running"),
  expectedVersion: z.string().min(1).max(100).optional(),
});
export const startupTriageResultSchema = z
  .strictObject({
    kind: z.literal("startup-repair"),
    installationRoot: z.string().min(1).max(4096),
    generationOwner: z.string().min(1).max(256),
    failure: failureSchema,
    attempted: z.boolean(),
    agentExitCode: z.number().int().optional(),
    before: validationSchema,
    after: validationSchema,
    repairTaskId: z.uuid().optional(),
  })
  .refine((value) =>
    value.attempted
      ? !value.before.ok && value.agentExitCode !== undefined
      : value.before.ok && value.agentExitCode === undefined && value.repairTaskId === undefined,
  );
export type StartupTriageResult = z.infer<typeof startupTriageResultSchema>;
export type StartupTriageValidation = z.infer<typeof validationSchema>;

/** Capture config, auth and port before repair; never use repaired config as the original request. */
export async function prepareStartupTriageValidator(
  env: NodeJS.ProcessEnv,
  failure: TriageFailureContext,
) {
  const capturedEnv = { ...env };
  const expectedVersion = failure.expectedVersion;
  const context = await createConfigIO({
    env: capturedEnv,
    observe: false,
    pluginValidation: "skip",
  })
    .readConfigFileSnapshot()
    .then(async (snapshot) => {
      if (!snapshot.valid) {
        return undefined;
      }
      const config = snapshot.config;
      const resolved = await resolveGatewayProbeAuthSafeWithSecretInputs({
        cfg: config,
        mode: "local",
        env: capturedEnv,
      });
      return { config, auth: resolved.auth };
    })
    .catch(() => undefined);
  const port = resolveGatewayPort(context?.config, capturedEnv);
  return async (
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<StartupTriageValidation> => {
    const guard = () => {
      signal.throwIfAborted();
      assertCurrent();
    };
    guard();
    try {
      if (!context) {
        return { ok: false, port, summary: "startup-unavailable" };
      }
      const params = { ...context, env: capturedEnv, port, signal };
      const first = await confirmGatewayReachable(params);
      guard();
      const http = await waitForGatewayHttpReadiness({
        config: context.config,
        port,
        attempts: 1,
        deadlineAt: Date.now() + 3000,
        delayMs: 0,
        signal,
      });
      guard();
      const last = await confirmGatewayReachable(params);
      guard();
      const stable = Boolean(
        first.gatewayBootId &&
        first.gatewayBootId === last.gatewayBootId &&
        first.gatewayVersion &&
        first.gatewayVersion === last.gatewayVersion &&
        first.gatewayBuildId === last.gatewayBuildId,
      );
      const ok =
        stable &&
        first.reachable &&
        last.reachable &&
        http.healthz === 200 &&
        http.readyz === 200 &&
        !first.activatedPluginErrors.length &&
        !last.activatedPluginErrors.length &&
        !first.channelProbeErrors.length &&
        !last.channelProbeErrors.length &&
        (!expectedVersion ||
          (first.gatewayVersion === expectedVersion && last.gatewayVersion === expectedVersion));
      return validationSchema.parse({
        ok,
        port,
        ...(last.gatewayBootId ? { bootId: last.gatewayBootId } : {}),
        ...(last.gatewayVersion ? { version: last.gatewayVersion } : {}),
        summary: ok ? "startup-verified" : "startup-unhealthy",
      });
    } catch {
      guard();
      return { ok: false, port, summary: "startup-unavailable" };
    }
  };
}

/** Runs the existing configured runtime only while the original startup symptom persists. */
export async function runStartupTriageRepair(params: {
  env: NodeJS.ProcessEnv;
  failure: TriageFailureContext;
  backing: TriageBackingReference;
  signal: AbortSignal;
  assertCurrent: () => void;
  run: () => Promise<{ exitCode: number; repairTaskId?: string }>;
}): Promise<StartupTriageResult> {
  const { kind, phase, gateway, expectedVersion } = params.failure;
  const failure = failureSchema.parse({ kind, phase, gateway, expectedVersion });
  const installationRoot = params.backing.installationRoot;
  const generationOwner = params.backing.generation.owner;
  const validate = await prepareStartupTriageValidator(params.env, params.failure);
  const before = await validate(params.signal, params.assertCurrent);
  const base = {
    kind: "startup-repair" as const,
    installationRoot,
    generationOwner,
    failure,
    before,
  };
  if (before.ok) {
    return { ...base, attempted: false, after: before };
  }
  params.signal.throwIfAborted();
  params.assertCurrent();
  const result = await params.run();
  const after = await validate(params.signal, params.assertCurrent);
  return startupTriageResultSchema.parse({
    ...base,
    attempted: true,
    agentExitCode: result.exitCode,
    repairTaskId: result.repairTaskId,
    after,
  });
}
