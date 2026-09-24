import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  startSecretEgressProxyServer,
  type SecretEgressProxyHandle,
} from "../secrets/egress-proxy/proxy-server.js";
import {
  clearSecretEgressProxy,
  publishSecretEgressProxy,
} from "../secrets/egress-proxy/registry.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createCronScriptRuntimeFixture as createCronScriptRuntime } from "./trigger-script.test-helpers.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
let proxy: SecretEgressProxyHandle | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (proxy) {
    clearSecretEgressProxy(proxy);
    await proxy.stop();
    proxy = undefined;
  }
  await state?.cleanup();
  state = undefined;
});

describe("cron script gateway exec with secret egress", () => {
  it.each(
    (["trigger", "payload"] as const).flatMap((mode) =>
      [false, true].map((enabled) => ({ mode, enabled })),
    ),
  )(
    "executes cold and warm $mode commands in a fresh agent with proxy enabled=$enabled",
    async ({ mode, enabled }) => {
      state = await createOpenClawTestState({
        prefix: "openclaw-cron-secret-egress-",
        layout: "state-only",
        env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      });
      const config: OpenClawConfig = {
        agents: {
          defaults: { workspace: state.workspaceDir, skipBootstrap: true },
          entries: { probe: { workspace: state.workspaceDir } },
        },
        plugins: { enabled: false },
        tools: { exec: { host: "gateway", security: "full", ask: "off" } },
        secrets: { egressProxy: { enabled } },
      };
      await state.writeConfig(config);
      if (enabled) {
        proxy = await startSecretEgressProxyServer({
          caDir: state.path("proxy-ca"),
          onAudit: () => {},
        });
        publishSecretEgressProxy(proxy);
      }
      const registrations = proxy ? vi.spyOn(proxy, "registerProcess") : undefined;
      const runtime = createCronScriptRuntime({ config });
      const admitted: AdmittedRunContext[] = [];
      for (let index = 0; index < 2; index += 1) {
        const params = {
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
            onPostAdmission: (context: AdmittedRunContext) => {
              admitted.push(context);
            },
          },
        };
        await expect(
          mode === "trigger" ? runtime.evaluateTrigger(params) : runtime.executePayload(params),
        ).resolves.toEqual(
          mode === "trigger"
            ? { kind: "evaluated", fire: false }
            : { kind: "completed", stateChanged: false },
        );
        expect(admitted).toHaveLength(index + 1);
        expect(getAdmittedRunDelegatedAuthority(admitted[index]!)).toBeUndefined();
        if (enabled) {
          expect(registrations).toHaveBeenCalledTimes(index + 1);
          const registration = registrations?.mock.results[index];
          if (registration?.type !== "return") {
            throw new Error("Expected the command's proxy grant");
          }
          const url = new URL(registration.value.env.HTTPS_PROXY!);
          const statusCode = await new Promise<number | undefined>((resolve, reject) => {
            const req = request(
              {
                hostname: url.hostname,
                port: url.port,
                agent: false,
                path: "https://example.invalid/",
                headers: {
                  "Proxy-Authorization": `Basic ${Buffer.from(`${url.username}:${url.password}`).toString("base64")}`,
                },
              },
              (response) => {
                response.resume();
                resolve(response.statusCode);
              },
            );
            req.on("error", reject);
            req.end();
          });
          expect(statusCode).toBe(407);
        }
      }
      expect(admitted[1]?.operationalRunInstance).not.toEqual(admitted[0]?.operationalRunInstance);
    },
  );
});
