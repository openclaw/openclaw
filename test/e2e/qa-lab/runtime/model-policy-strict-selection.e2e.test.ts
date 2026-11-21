import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { runQaGatewayTestFixture } from "../../../helpers/qa-gateway-test-lifetime.js";
import {
  closeNativeProvider,
  createNativeProvider,
  listenNativeProvider,
  nativeModel,
  writeNativeCompletion,
} from "./native-provider-proof-fixture.js";

// Real HTTP -> Gateway -> agent selection -> recording provider. No model or
// selection mocks: a successful control proves the alternate is executable.
it("rejects a disallowed strict primary before streaming to another provider", async (context) => {
  const requests: string[] = [];
  const providerErrors: unknown[] = [];
  let gateway: OpenClawTestInstance | undefined;
  const provider = createNativeProvider(
    async (request, response, rawBody) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(rawBody) as { model: string };
      requests.push(body.model);
      writeNativeCompletion(response, "policy-proof", body.model, "POLICY_CONTROL_OK");
    },
    (error, response) => {
      providerErrors.push(error);
      response.writeHead(500).end("recording provider failed");
    },
  );
  await runQaGatewayTestFixture(
    context,
    async ({ signal, verifyCleanup }) => {
      const baseUrl = await listenNativeProvider(provider);
      gateway = await createOpenClawTestInstance({
        name: "model-policy-strict-selection",
        signal,
        verifyCleanup,
        env: {
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENAI_API_KEY: undefined,
          ANTHROPIC_API_KEY: undefined,
          CODEX_HOME: undefined,
        },
        config: {
          gateway: {
            mode: "local",
            bind: "loopback",
            http: { endpoints: { chatCompletions: { enabled: true } } },
          },
          agents: {
            ownership: "explicit",
            defaults: {
              model: { primary: "alternate/allowed", fallbacks: [] },
              modelPolicy: { allow: ["alternate/*"] },
              utilityModel: "",
              skipBootstrap: true,
              timeoutSeconds: 30,
            },
            entries: {
              control: { model: { primary: "alternate/allowed", fallbacks: [] } },
              fastbot: { model: { primary: "requested/blocked", fallbacks: [] } },
            },
          },
          tools: { deny: ["*"] },
          plugins: {
            allow: ["openai"],
            entries: { openai: { enabled: true } },
            slots: { memory: "none" },
          },
          models: {
            mode: "replace",
            providers: Object.fromEntries(
              [
                ["alternate", "allowed"],
                ["requested", "blocked"],
              ].map(([id, model]) => [
                id,
                {
                  baseUrl,
                  api: "openai-completions",
                  apiKey: "synthetic-model-policy-key",
                  request: { allowPrivateNetwork: true },
                  models: [nativeModel(model!)],
                },
              ]),
            ),
          },
        },
      });
      const doctor = await gateway.cli(["doctor", "--fix", "--yes", "--non-interactive"], {
        timeoutMs: 120_000,
      });
      expect(doctor.code, doctor.stderr).toBe(0);
      await gateway.startGateway();
      const chat = async (agent: string, stream = true) => {
        const response = await fetch("http://127.0.0.1:" + gateway!.port + "/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: "Bearer " + gateway!.gatewayToken,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "openclaw/" + agent,
            stream,
            messages: [{ role: "user", content: "Say hello in five words. No tools." }],
          }),
          signal,
        });
        const text = await response.text();
        expect(response.status, text).toBe(stream ? 200 : 403);
        if (stream) {
          expect(text).toContain("data: [DONE]");
        }
        return text;
      };
      expect(await chat("control")).toContain("POLICY_CONTROL_OK");
      expect(requests).toEqual(["allowed"]);
      requests.length = 0;

      for (const stream of [true, false]) {
        const rejected = await chat("fastbot", stream);
        expect(requests, rejected).toEqual([]);
        expect(rejected).toContain('"type":"permission_error"');
        expect(rejected).toContain("requested/blocked");
        expect(rejected).toContain("agents.defaults.modelPolicy.allow");
        expect(rejected).toContain("model fallback is disabled");
        expect(rejected).not.toContain("POLICY_CONTROL_OK");
      }
      expect(providerErrors).toEqual([]);
    },
    () => gateway?.cleanup(),
    () => closeNativeProvider(provider),
  );
}, 180_000);
