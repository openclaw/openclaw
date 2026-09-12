import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { GatewayClient } from "../src/gateway/client.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { createDeferred } from "./helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

let instance: OpenClawTestInstance | undefined;
let provider: ChildProcess | undefined;
let observer: GatewayClient | undefined;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      try {
        await observer?.stopAndWait();
      } finally {
        await instance?.cleanup();
      }
    } finally {
      try {
        if (provider && provider.exitCode === null && provider.signalCode === null) {
          const exited = once(provider, "exit");
          provider.kill("SIGTERM");
          await exited;
        }
      } finally {
        cleanup();
        instance = undefined;
        provider = undefined;
        observer = undefined;
      }
    }
  }),
);

const historySchema = z.object({
  defaults: z.object({ modelProvider: z.string(), model: z.string() }),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.union([
        z.string(),
        z.array(z.object({ type: z.string(), text: z.string().optional() })),
      ]),
    }),
  ),
  sessionInfo: z.object({
    modelProvider: z.string(),
    model: z.string(),
    modelOverrideSource: z.string().nullable().optional(),
  }),
});

it.each([
  { scenario: "an authored typo", missing: "misspelled-primary", withdrawn: false, pinned: false },
  { scenario: "a withdrawn primary", missing: "withdrawn-model", withdrawn: true, pinned: false },
  {
    scenario: "a typo with a blocked pin",
    missing: "misspelled-primary",
    withdrawn: false,
    pinned: true,
  },
])(
  "chat.send menus, reset, replies and the agent CLI use the effective default after $scenario",
  async ({ missing, withdrawn, pinned }) => {
    const scratch = tempDirs.make("openclaw-missing-primary-");
    const responsePath = path.join(scratch, "response.json");
    const requestPath = path.join(scratch, "requests.ndjson");
    await fs.writeFile(responsePath, JSON.stringify({ text: "Default response." }));
    await fs.writeFile(requestPath, "");
    const child = spawn(process.execPath, ["scripts/e2e/mock-openai-server.mjs"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        MOCK_PORT: "0",
        MOCK_RESPONSE_CONTROL: responsePath,
        MOCK_REQUEST_LOG: requestPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    provider = child;
    const output = createInterface({ input: child.stdout });
    let port: number | undefined;
    for await (const line of output) {
      const match = /^mock-openai listening on (\d+)$/u.exec(line);
      if (match) {
        port = Number(match[1]);
        break;
      }
    }
    expect(port).toBeTypeOf("number");
    const configuredModels = [
      { id: "fixture-primary", name: "Primary", contextWindow: 128000 },
      { id: "fixture-pin", name: "Pinned", contextWindow: 128000 },
      ...(withdrawn
        ? [{ id: "withdrawn-model", name: "Previously available", contextWindow: 128000 }]
        : []),
    ];
    const runtime = await createOpenClawTestInstance({
      name: "missing-configured-primary",
      env: {
        OPENCLAW_SHELL: "exec",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_SKIP_PROVIDERS: "0",
      },
      config: {
        cron: { enabled: false },
        agents: {
          ownership: "explicit",
          defaults: {
            model: withdrawn ? "openai/withdrawn-model" : "openai/fixture-primary",
            modelPolicy: { allow: ["openai/*"] },
          },
          entries: { main: {} },
        },
        models: {
          mode: "replace",
          catalogRefresh: { enabled: false },
          providers: {
            openai: {
              api: "openai-completions",
              apiKey: "FAKE_MISSING_PRIMARY_CREDENTIAL",
              baseUrl: `http://127.0.0.1:${port}/v1`,
              agentRuntime: { id: "openclaw" },
              models: configuredModels,
            },
          },
        },
        plugins: { allow: ["openai"], entries: { openai: { enabled: true } } },
      },
    });
    instance = runtime;
    async function call(method: string, params: Record<string, unknown>) {
      const result = await runtime.cli([
        "gateway",
        "call",
        method,
        "--json",
        "--params",
        JSON.stringify(params),
      ]);
      expect(result.code, `${method}: ${result.stderr}\n${result.stdout}`).toBe(0);
      const payload: unknown = JSON.parse(result.stdout);
      return payload;
    }
    async function requestedModels() {
      const records = z.array(z.object({ path: z.string(), body: z.unknown() })).parse(
        (await fs.readFile(requestPath, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
      return records
        .filter((record) => record.path.endsWith("/chat/completions"))
        .map(
          (record) =>
            z
              .object({ model: z.string() })
              .parse(typeof record.body === "string" ? JSON.parse(record.body) : record.body).model,
        );
    }
    const key = "agent:main:missing-primary";
    await runtime.startGateway();
    await call("sessions.create", {
      key,
      agentId: "main",
      ...(pinned ? { model: "openai/fixture-pin" } : {}),
    });
    const control = randomUUID();
    expect(
      await call("chat.send", {
        sessionKey: key,
        message: "Use the currently available configured model.",
        idempotencyKey: control,
      }),
    ).toMatchObject({ runId: control });
    expect(await call("agent.wait", { runId: control, timeoutMs: 20_000 })).toMatchObject({
      runId: control,
      status: "ok",
    });
    expect(await requestedModels()).toEqual([
      pinned ? "fixture-pin" : withdrawn ? "withdrawn-model" : "fixture-primary",
    ]);
    await runtime.stopGateway();
    const edits: Array<[string, unknown]> = [
      ["agents.defaults.model", `openai/${missing}`],
      [
        "models.providers.openai.models",
        configuredModels.filter((model) => model.id !== "withdrawn-model"),
      ],
      ["agents.defaults.modelPolicy.allow", pinned ? ["openai/fixture-primary"] : ["openai/*"]],
    ];
    for (const [configKey, value] of edits) {
      const edit = await runtime.cli([
        "config",
        "set",
        configKey,
        JSON.stringify(value),
        "--strict-json",
        "--replace",
      ]);
      expect(edit.code, edit.stderr).toBe(0);
    }
    await runtime.startGateway();
    const runId = randomUUID();
    const hello = createDeferred<void>();
    const final = createDeferred<unknown>();
    const deliveries = new Map([[runId, final]]);
    const finalResult = final.promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    observer = new GatewayClient({
      url: runtime.url,
      token: runtime.gatewayToken,
      clientName: "cli",
      mode: "cli",
      scopes: ["operator.admin"],
      caps: ["session-scoped-events"],
      sharedStateMode: "read-only",
      onHelloOk: () => hello.resolve(),
      onConnectError: hello.reject,
      onEvent: (event) => {
        if (event.event !== "chat") {
          return;
        }
        const payload = z
          .object({ runId: z.string(), state: z.string(), message: z.unknown().optional() })
          .parse(event.payload);
        const delivery = deliveries.get(payload.runId);
        if (!delivery) {
          return;
        }
        if (payload.state === "final") {
          delivery.resolve(payload.message);
        }
        if (payload.state === "error" || payload.state === "aborted") {
          delivery.reject(new Error(JSON.stringify(event.payload)));
        }
      },
    });
    observer.start();
    await hello.promise;
    await observer.request("sessions.messages.subscribe", { key, agentId: "main" });
    expect(
      await observer.request("chat.send", {
        sessionKey: key,
        message: "Use the effective default after the config change.",
        idempotencyKey: runId,
      }),
    ).toMatchObject({ runId });
    expect(await call("agent.wait", { runId, timeoutMs: 20_000 })).toMatchObject({
      runId,
      status: "ok",
    });
    const finalMessage = await finalResult;
    if ("error" in finalMessage) {
      throw finalMessage.error;
    }
    const delivered = historySchema.shape.messages.element.parse(finalMessage.value);
    expect((await requestedModels()).slice(1)).toEqual(["fixture-primary"]);
    const history = historySchema.parse(await call("chat.history", { sessionKey: key, limit: 20 }));
    expect(history.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    const content = history.messages.at(-1)?.content;
    const text =
      typeof content === "string"
        ? content
        : content
            ?.filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
    const notice = `Configured primary openai/${missing} is not in the model catalog. This reply used the default (openai/fixture-primary). Update your primary model in settings.`;
    const deliveredText =
      typeof delivered.content === "string"
        ? delivered.content
        : delivered.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
    expect(deliveredText).toBe(text);
    expect(text).toContain(notice);
    expect(text).toContain("Default response.");
    expect(text?.split(notice)).toHaveLength(2);
    expect(history.defaults).toEqual({ modelProvider: "openai", model: "fixture-primary" });
    expect(history.sessionInfo).toEqual({
      modelProvider: "openai",
      model: pinned ? "fixture-pin" : "fixture-primary",
      modelOverrideSource: pinned ? "user" : null,
    });
    const catalog = z
      .object({
        models: z.array(
          z.object({ id: z.string(), provider: z.string(), tags: z.array(z.string()).optional() }),
        ),
      })
      .parse(await call("models.list", { agentId: "main", sessionKey: key }));
    expect(catalog.models.some((model) => model.id === missing)).toBe(false);
    expect(catalog.models.find((model) => model.id === "fixture-primary")?.tags).toContain(
      "default",
    );
    const beforeCli = (await requestedModels()).length;
    const command = await runtime.cli([
      "agent",
      "--local",
      "--agent",
      "main",
      "--session-id",
      randomUUID(),
      "--message",
      "Use the configured effective default.",
      "--json",
    ]);
    expect(command.code, command.stderr).toBe(0);
    expect((await requestedModels()).slice(beforeCli)).toEqual(["fixture-primary"]);
    const commandOutput = z
      .object({ payloads: z.array(z.object({ text: z.string() })) })
      .parse(JSON.parse(command.stdout));
    expect(commandOutput.payloads.map((payload) => payload.text)).toEqual([
      `${notice}\n\nDefault response.`,
    ]);
    const beforeMenuRequests = (await requestedModels()).length;
    for (const [message, expectedText] of [
      ["/models list openai all", "- openai/fixture-primary (Default)"],
      ["/model default -s", "Session model reset to configured default (openai/fixture-primary)"],
    ] as const) {
      const commandRunId = randomUUID();
      const commandFinal = createDeferred<unknown>();
      const commandResult = commandFinal.promise.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      deliveries.set(commandRunId, commandFinal);
      await observer.request("chat.send", {
        sessionKey: key,
        message,
        idempotencyKey: commandRunId,
      });
      const completed = await commandResult;
      if ("error" in completed) {
        throw completed.error;
      }
      const commandReply = historySchema.shape.messages.element.parse(completed.value);
      const commandText =
        typeof commandReply.content === "string"
          ? commandReply.content
          : commandReply.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");
      expect(commandText).toContain(expectedText);
      expect(commandText).not.toContain(`- openai/${missing} (Default)`);
    }
    expect((await requestedModels()).length).toBe(beforeMenuRequests);
    const resetHistory = historySchema.parse(
      await call("chat.history", { sessionKey: key, limit: 20 }),
    );
    expect(resetHistory.sessionInfo).toEqual({
      modelProvider: "openai",
      model: "fixture-primary",
      modelOverrideSource: null,
    });
    if (withdrawn) {
      const unrunKey = "agent:main:unrun";
      await call("sessions.create", { key: unrunKey, agentId: "main" });
      await observer.stopAndWait();
      observer = undefined;
      await runtime.stopGateway();
      const removeReplacement = await runtime.cli([
        "config",
        "set",
        "agents.defaults.modelPolicy.allow",
        JSON.stringify(["unavailable-provider/*"]),
        "--strict-json",
        "--replace",
      ]);
      expect(removeReplacement.code, removeReplacement.stderr).toBe(0);
      await runtime.startGateway();
      const absentSelection = z.object({
        modelProvider: z.string().optional(),
        model: z.string().optional(),
        activeModelProvider: z.string().optional(),
        activeModel: z.string().optional(),
        agentRuntime: z.unknown().optional(),
        thinkingLevels: z.unknown().optional(),
        effectiveFastMode: z.unknown().optional(),
      });
      const absentDefaults = z.object({
        modelProvider: z.string().nullable(),
        model: z.string().nullable(),
        contextTokens: z.number().nullable(),
      });
      const unavailableHistory = z.object({
        defaults: absentDefaults,
        sessionInfo: absentSelection,
      });
      for (const sessionKey of [key, unrunKey]) {
        const unavailable = unavailableHistory.parse(
          await call("chat.history", { sessionKey, limit: 20 }),
        );
        expect(unavailable.defaults).toEqual({
          modelProvider: null,
          model: null,
          contextTokens: null,
        });
        expect(unavailable.sessionInfo).toEqual({});
      }
      const listSchema = z.object({
        defaults: absentDefaults,
        sessions: z.array(absentSelection.extend({ key: z.string() })),
      });
      const unavailableList = listSchema.parse(await call("sessions.list", { agentId: "main" }));
      expect(unavailableList.defaults).toEqual({
        modelProvider: null,
        model: null,
        contextTokens: null,
      });
      expect(unavailableList.sessions.find((session) => session.key === unrunKey)).toEqual({
        key: unrunKey,
      });
      const historicalSearch = listSchema.parse(
        await call("sessions.list", { agentId: "main", search: "fixture-primary" }),
      );
      expect(historicalSearch.sessions.map((session) => session.key)).toContain(key);
      expect(historicalSearch.sessions.map((session) => session.key)).not.toContain(unrunKey);
      const authoredSearch = listSchema.parse(
        await call("sessions.list", { agentId: "main", search: "withdrawn-model" }),
      );
      expect(authoredSearch.sessions.map((session) => session.key)).not.toContain(unrunKey);
    }
  },
);
