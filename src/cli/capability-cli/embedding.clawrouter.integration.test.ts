import "../../test-utils/prepare-compiled-subprocesses.js";
import { createServer } from "node:http";
import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { registerCapabilityCli } from "../capability-cli.js";

it("creates qualified ClawRouter embeddings through the registered CLI without a chat catalog row", async () => {
  const requests: Array<{ url?: string; authorization?: string; body: unknown }> = [];
  const fixture = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const body: { model: string; input: string[] } = JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          );
          requests.push({ url: request.url, authorization: request.headers.authorization, body });
          if (request.url !== "/v1/embeddings") {
            response.writeHead(404).end();
            return;
          }
          const status =
            body.model === "openai/forbidden" ? 403 : body.model === "openai/unknown" ? 404 : 200;
          response.writeHead(status, { "content-type": "application/json" });
          response.end(
            JSON.stringify(
              status === 200
                ? {
                    data: [
                      { index: 1, embedding: [0, 1, 0] },
                      { index: 0, embedding: [1, 0, 0] },
                    ],
                  }
                : { error: { message: status === 403 ? "model_not_allowed" : "model_not_found" } },
            ),
          );
        })().catch((error: unknown) =>
          response.destroy(error instanceof Error ? error : new Error(String(error))),
        );
      }),
  });
  try {
    await withOpenClawTestState({ label: "clawrouter-embedding-cli" }, async (state) => {
      await state.writeConfig({
        agents: { entries: { main: {} } },
        plugins: { enabled: false },
        models: {
          providers: {
            clawrouter: {
              api: "openai-completions",
              baseUrl: `http://127.0.0.1:${fixture.claim.port}/v1`,
              apiKey: { source: "env", provider: "default", id: "CLAWROUTER_API_KEY" },
              models: [],
            },
          },
        },
        memory: {
          search: {
            provider: "clawrouter",
            model: "openai/text-embedding-3-large",
            fallback: "none",
          },
        },
      });
      vi.stubEnv("CLAWROUTER_API_KEY", "synthetic-router-key");
      const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      const errors = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
        throw new Error(`exit ${code}`);
      });
      const run = async (model: string) => {
        const argv = [
          "infer",
          "embedding",
          "create",
          "--agent",
          "main",
          "--model",
          `clawrouter/${model}`,
          "--text",
          "hello",
          "--text",
          "world",
          "--json",
        ];
        const program = new Command();
        await registerCapabilityCli(program, ["node", "openclaw", ...argv]);
        await program.parseAsync(argv, { from: "user" });
      };
      try {
        await run("openai/text-embedding-3-large");
        expect(output).toHaveBeenLastCalledWith(
          expect.objectContaining({
            ok: true,
            provider: "openai-compatible",
            model: "openai/text-embedding-3-large",
            attempts: [],
            outputs: [
              { text: "hello", embedding: [1, 0, 0], dimensions: 3 },
              { text: "world", embedding: [0, 1, 0], dimensions: 3 },
            ],
          }),
          2,
        );
        for (const [model, status, message] of [
          ["openai/forbidden", 403, "model_not_allowed"],
          ["openai/unknown", 404, "model_not_found"],
        ] as const) {
          await expect(run(model)).rejects.toThrow("exit 1");
          expect(errors.mock.calls.at(-1)?.[0]).toContain(`HTTP ${status}`);
          expect(errors.mock.calls.at(-1)?.[0]).toContain(message);
        }
        // A later call must still work after both terminal failures; no alternate account or batch route is tried.
        await run("openai/text-embedding-3-large");
        expect(output).toHaveBeenCalledTimes(2);
        expect(requests).toEqual(
          [
            "openai/text-embedding-3-large",
            "openai/forbidden",
            "openai/unknown",
            "openai/text-embedding-3-large",
          ].map((model) => ({
            url: "/v1/embeddings",
            authorization: "Bearer synthetic-router-key",
            body: { model, input: ["hello", "world"] },
          })),
        );
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    });
  } finally {
    fixture.listener.closeAllConnections();
    try {
      await fixture.releaseListener();
    } finally {
      await fixture.claim.release();
    }
  }
});
