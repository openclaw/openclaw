import path from "node:path";

export function transportHostFixtureFiles(
  repoRoot: string,
  fixtureRoot: string,
): Record<string, string> {
  const source = (file: string) => JSON.stringify(path.join(repoRoot, file));
  const shared = `
import { configureAiTransportHost, getDefaultAiTransportHost } from ${source("packages/ai/src/host.ts")};
import { makeProviderModelFixture } from ${source("src/agents/test-helpers/provider-model-fixture.ts")};
const model = makeProviderModelFixture({
  id: "host-lifetime", provider: "openai", api: "openai-completions",
  baseUrl: "https://host-lifetime.invalid/v1",
});
const response = text => new Response(
  'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] }) + '\\n\\ndata: [DONE]\\n\\n',
  { headers: { "content-type": "text/event-stream" } },
);
const context = { messages: [{ role: "user", content: "Synthetic host lifetime", timestamp: 0 }] };
`;
  return {
    "transport-host-native.cjs": 'module.exports = require("openclaw/plugin-sdk/llm");\n',
    "09-host-a-producer.test.ts": `
import { afterAll, expect, it, vi } from "vitest";
import { createPluginModuleLoader } from ${source("src/plugins/loader-module-runtime.ts")};
import ${source("src/agents/ai-transport-runtime-host.ts")};
${shared}
const load = createPluginModuleLoader({ tryNative: true, pluginSdkResolution: "src" });
const sdk = load(${JSON.stringify(path.join(fixtureRoot, "transport-host-native.cjs"))});
vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected real fetch"));
configureAiTransportHost({ ...getDefaultAiTransportHost(), buildModelFetch: () => async () => response("producer") });
// The public call initializes the retained native graph before the file-boundary assertions.
const produced = await sdk.complete(model, context, { apiKey: "synthetic-key" });
it("retains file transport policy through producer teardown", () => {
  expect(produced.content).toEqual([
    { type: "text", text: "producer" },
  ]);
  globalThis.__retainedTransportSdk = sdk;
  configureAiTransportHost({ ...getDefaultAiTransportHost(), resolveSecretSentinel: () => "producer-policy" });
});
afterAll(() => {
  expect(getDefaultAiTransportHost().resolveSecretSentinel("input")).toBe("producer-policy");
});
`,
    "09-host-b-observer.test.ts": `
import { afterAll, expect, it, vi } from "vitest";
import { attachProviderAuthAuthority } from ${source("src/plugins/provider-auth-authority.ts")};
${shared}
afterAll(() => { delete globalThis.__retainedTransportSdk; });
it("retires file policy and shares fresh guarded policy with retained native providers", async () => {
  expect(getDefaultAiTransportHost().resolveSecretSentinel("input")).toBe("input");
  await import(${source("src/agents/ai-transport-runtime-host.ts")});
  const host = getDefaultAiTransportHost();
  const unexpectedFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected real fetch"));
  const revoked = new Error("Synthetic credential owner retired");
  const fetcher = host.buildModelFetch(attachProviderAuthAuthority(model, () => { throw revoked; }));
  expect(fetcher).toBeTypeOf("function");
  await expect(fetcher(model.baseUrl + "/chat/completions")).rejects.toBe(revoked);
  expect(unexpectedFetch).not.toHaveBeenCalled();
  const observedFetch = vi.fn(async () => response("observer"));
  configureAiTransportHost({ ...host, buildModelFetch: () => observedFetch });
  const sdk = globalThis.__retainedTransportSdk;
  expect((await sdk.complete(model, context, { apiKey: "synthetic-key" })).content).toEqual([
    { type: "text", text: "observer" },
  ]);
  expect(observedFetch).toHaveBeenCalledOnce();
});
`,
  };
}
