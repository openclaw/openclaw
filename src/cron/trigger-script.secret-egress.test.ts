import { get, type IncomingMessage } from "node:http";
import { expect, it, onTestFinished, vi } from "vitest";
import * as admission from "../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { startSecretEgressProxyServer } from "../secrets/egress-proxy/proxy-server.js";
import * as proxyRegistry from "../secrets/egress-proxy/registry.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createCronScriptRuntimeFixture as createCronScriptRuntime } from "./trigger-script.test-helpers.js";

it("revokes proxy grants after cold and warm trigger commands in a fresh agent", async () => {
  const state = await createOpenClawTestState({
    prefix: "openclaw-cron-secret-egress-",
    layout: "state-only",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  onTestFinished(() => state.cleanup());
  const config: OpenClawConfig = {
    agents: {
      defaults: { workspace: state.workspaceDir, skipBootstrap: true },
      entries: { probe: { workspace: state.workspaceDir } },
    },
    plugins: { enabled: false },
    tools: { exec: { host: "gateway", security: "full", ask: "off" } },
    secrets: { egressProxy: { enabled: true } },
  };
  await state.writeConfig(config);
  const proxy = await startSecretEgressProxyServer({
    caDir: state.path("proxy-ca"),
    onAudit: () => {},
  });
  onTestFinished(async () => {
    vi.restoreAllMocks();
    proxyRegistry.clearSecretEgressProxy(proxy);
    await proxy.stop();
  });
  proxyRegistry.publishSecretEgressProxy(proxy);
  const registrations = vi.spyOn(proxy, "registerProcess");
  const runtime = createCronScriptRuntime({ config });
  const admitted: admission.AdmittedRunContext[] = [];
  for (let index = 0; index < 2; index += 1) {
    await expect(
      runtime.evaluateTrigger({
        jobId: "fresh-agent-check",
        agentId: "probe",
        script:
          'const result = await exec({ command: "printf cron-egress-ok" }); if (!JSON.stringify(result).includes("cron-egress-ok")) throw new Error("Command output missing"); return { fire: false };',
        state: null,
        toolsAllow: ["exec", "process"],
        scheduledToolPolicy: { version: 1, mode: "trusted" } as const,
        execTarget: { version: 1, host: "gateway" } as const,
        executionIdentity: {
          ingress: { kind: "schedule", boundary: "cron.script", state: "present" } as const,
          onPostAdmission: (context) => void admitted.push(context),
        },
      }),
    ).resolves.toEqual({ kind: "evaluated", fire: false });
    expect(admitted).toHaveLength(index + 1);
    expect(admission.getAdmittedRunDelegatedAuthority(admitted[index]!)).toBeUndefined();
    expect(registrations).toHaveBeenCalledTimes(index + 1);
    const registration = registrations.mock.results[index];
    if (registration?.type !== "return") {
      throw new Error("Expected the command's proxy grant");
    }
    const url = new URL(registration.value.env.HTTPS_PROXY!);
    const credentials = Buffer.from(`${url.username}:${url.password}`).toString("base64");
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      get(
        {
          hostname: url.hostname,
          port: url.port,
          agent: false,
          path: "https://example.invalid/",
          headers: { "Proxy-Authorization": `Basic ${credentials}` },
        },
        resolve,
      ).on("error", reject);
    });
    response.resume();
    expect(response.statusCode).toBe(407);
  }
  expect(admitted[1]?.operationalRunInstance).not.toEqual(admitted[0]?.operationalRunInstance);
});
