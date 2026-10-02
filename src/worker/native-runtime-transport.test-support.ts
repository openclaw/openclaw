import type { NativeRuntimeConfig } from "./native-runtime-config.js";
import { createNativeRuntime } from "./native-runtime.js";

process.on(
  "message",
  (message: { id: number; config: NativeRuntimeConfig; credential: string }) => {
    void (async () => {
      let runtime: Awaited<ReturnType<typeof createNativeRuntime>> | undefined;
      try {
        runtime = await createNativeRuntime(message.config, {
          NATIVE_PROXY_AUTH: message.credential,
        });
        const selected = message.config.models[0]!;
        const result = await runtime.withTurn(
          {
            binding: { workspaceId: "test" },
            selection: { provider: selected.provider, modelId: selected.id },
          },
          async ({ model, streamFn }) => {
            const stream = await streamFn(
              model,
              { messages: [{ role: "user", content: "qualify transport", timestamp: 1 }] },
              { maxRetryDelayMs: 1 },
            );
            const response = await stream.result();
            return {
              stopReason: response.stopReason,
              text: response.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join(""),
            };
          },
        );
        process.send?.({ id: message.id, ...result });
      } catch {
        process.send?.({ id: message.id, stopReason: "startup-error" });
      } finally {
        runtime?.close();
      }
    })();
  },
);
process.on("disconnect", () => process.exit(0));
