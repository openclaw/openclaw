import { once } from "node:events";
import type { IncomingHttpHeaders } from "node:http";
import { CANCEL_SYMBOL } from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type {
  UsersAuthConnectCatalogResult,
  UsersAuthConnectStartResult,
  UsersAuthConnectStatusResult,
  UsersListModelAccountsResult,
  UsersSelfResult,
} from "../../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../../gateway/minimal-gateway.test-helpers.js";
import { ExitError } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { DEVICE_CODE_PHISHING_WARNING } from "../../wizard/prompts.js";
import { sanitizeWizardStepForClient, WizardSession } from "../../wizard/session.js";
import {
  modelsAccountsUpdateDefaultCommand,
  modelsAccountsLoginCommand,
  modelsAccountsListCommand,
} from "./accounts.js";

const mocks = vi.hoisted(() => ({
  password: vi.fn<typeof import("@clack/prompts").password>(),
  autocomplete: vi.fn<typeof import("@clack/prompts").autocomplete>(),
  openUrl: vi.fn(async () => false),
}));
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  password: mocks.password,
  autocomplete: mocks.autocomplete,
}));
vi.mock("../../infra/browser-open.js", () => ({ openUrl: mocks.openUrl }));

const PROFILE_ID = "person-test";
const ACCOUNT_ID = "personal-account-first";
const connected = {
  status: "connected",
  authProfileId: ACCOUNT_ID,
  links: [{ provider: "openai", authProfileId: ACCOUNT_ID, updatedAt: 1 }],
} satisfies UsersAuthConnectStatusResult;
const catalog = {
  providers: [
    { id: "openai", label: "OpenAI", methods: [{ id: "oauth", label: "Browser sign-in" }] },
  ],
} satisfies UsersAuthConnectCatalogResult;
const inputStep = {
  id: "redirect-input",
  type: "text",
  message: "Final redirect URL",
  sensitive: true,
  externalUrl: "https://auth.example/authorize?state=synthetic-state",
} as const;
const self = {
  profile: {
    id: PROFILE_ID,
    displayName: "Test Person",
    avatarMime: null,
    mergedInto: null,
    createdAt: 1,
    updatedAt: 1,
    emails: [],
    githubIdentity: null,
    hasAvatar: false,
  },
} satisfies UsersSelfResult;

type Request = {
  method: string;
  params: Record<string, unknown>;
  socket: WebSocket;
};
const operation = { profileId: PROFILE_ID, connectId: "operation-one" };
const pendingInput = { status: "pending", step: inputStep };
const rpc = (method: string, params: Request["params"] = {}) => ({ method, params });
const authRpc = (method: string, params: Request["params"] = operation) =>
  rpc(`users.authConnect.${method}`, params);
const requestData = (requests: Request[]) =>
  requests.map(({ method, params }) => ({ method, params }));
const methods = (requests: Request[]) => requests.map(({ method }) => method);
const printed = (output: ReturnType<typeof runtime>) =>
  JSON.stringify([output.log.mock.calls, output.error.mock.calls, output.writeJson.mock.calls]);
const login = (port: string, output = runtime(), json = false) =>
  modelsAccountsLoginCommand({ port, provider: "openai", json }, output);
function expectNoPrompt() {
  expect(mocks.password).not.toHaveBeenCalled();
  expect(mocks.openUrl).not.toHaveBeenCalled();
}

async function withGateway(
  respond: (request: Request) => unknown,
  run: (gateway: {
    port: string;
    url: string;
    requests: Request[];
    connections: Request[];
    upgradeHeaders: IncomingHttpHeaders[];
  }) => Promise<void>,
  options: { config?: OpenClawConfig; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  await withOpenClawTestState(
    { label: "personal-account-cli", scenario: "minimal", env: options.env },
    async (state) => {
      const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      const requests: Request[] = [];
      const connections: Request[] = [];
      const upgradeHeaders: IncomingHttpHeaders[] = [];
      server.on("connection", (socket, upgrade) => {
        upgradeHeaders.push(upgrade.headers);
        sendMinimalGatewayConnectChallenge(socket);
        socket.on("message", (data) => {
          const frame = parseMinimalGatewayRequestFrame(data);
          if (!frame.id || !frame.method) {
            return;
          }
          const id = frame.id;
          const request = { method: frame.method, params: frame.params ?? {}, socket };
          if (frame.method === "connect") {
            connections.push(request);
            sendMinimalGatewayResponse(socket, id, buildMinimalGatewayHelloOkPayload());
            return;
          }
          requests.push(request);
          void Promise.resolve()
            .then(() => respond(request))
            .then(
              (payload) => {
                if (socket.readyState === WebSocket.OPEN) {
                  sendMinimalGatewayResponse(
                    socket,
                    id,
                    payload ??
                      (request.method === "users.self"
                        ? self
                        : request.method === "users.authConnect.catalog"
                          ? catalog
                          : {}),
                  );
                }
                return undefined;
              },
              () => {
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(
                    JSON.stringify({
                      type: "res",
                      id,
                      ok: false,
                      error: { code: "FORBIDDEN", message: "Requires an authenticated user" },
                    }),
                  );
                }
                return undefined;
              },
            );
        });
      });
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an ephemeral Gateway port.");
      }
      await state.writeConfig(
        options.config ?? {
          gateway: { mode: "local", port: address.port, auth: { mode: "none" } },
        },
      );
      try {
        await run({
          port: String(address.port),
          url: `ws://127.0.0.1:${address.port}`,
          requests,
          connections,
          upgradeHeaders,
        });
      } finally {
        await closeMinimalGatewayServer(server);
      }
    },
  );
}

function runtime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: (code: number) => {
      throw new ExitError(code);
    },
  };
}

function expectJsonOutput(output: ReturnType<typeof runtime>, payload: unknown): void {
  expect(output.writeJson.mock.calls.map(([value]) => value)).toEqual([payload]);
}
function expectLoginOutput(
  output: ReturnType<typeof runtime>,
  result: UsersAuthConnectStatusResult,
  provider = "openai",
) {
  expectJsonOutput(output, { profileId: PROFILE_ID, provider, ...result });
}

function expectPersonalContext(output: ReturnType<typeof runtime>, url: string): void {
  const diagnostics = output.error.mock.calls.map(([line]) => String(line)).join("\n");
  expect(diagnostics).toContain("Scope: Personal");
  expect(diagnostics).toContain(`Gateway: ${url}`);
  expect(diagnostics).toContain(`Person: ${self.profile.displayName}`);
}

function startResult(): UsersAuthConnectStartResult {
  return {
    connectId: "operation-one",
    expiresAtMs: Date.now() + 60_000,
  };
}

function withAuthGateway(
  handlers: Partial<
    Record<"catalog" | "start" | "status" | "answer" | "cancel", (request: Request) => unknown>
  >,
  run: Parameters<typeof withGateway>[1],
) {
  const responses: Record<string, ((request: Request) => unknown) | undefined> = {
    "users.authConnect.start": startResult,
    ...Object.fromEntries(
      Object.entries(handlers).map(([method, handler]) => [`users.authConnect.${method}`, handler]),
    ),
  };
  return withGateway((request) => responses[request.method]?.(request), run);
}

function waitForPromptAbort(): void {
  mocks.password.mockImplementation(
    ({ signal }) =>
      new Promise((resolve) => {
        if (signal?.aborted) {
          resolve(CANCEL_SYMBOL);
        } else {
          signal?.addEventListener("abort", () => resolve(CANCEL_SYMBOL), { once: true });
        }
      }),
  );
}

const ttyDescriptors = [process.stdin, process.stderr].map(
  (stream) => [stream, Object.getOwnPropertyDescriptor(stream, "isTTY")] as const,
);
beforeEach(() => {
  for (const [stream] of ttyDescriptors) {
    Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
  }
  mocks.password.mockReset();
  mocks.autocomplete.mockReset();
  mocks.openUrl.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [stream, descriptor] of ttyDescriptors) {
    if (descriptor) {
      Object.defineProperty(stream, "isTTY", descriptor);
    } else {
      Reflect.deleteProperty(stream, "isTTY");
    }
  }
});

describe("personal model account CLI over an identified Gateway connection", () => {
  it("prints one metadata page and its next cursor without fetching another page", async () => {
    const page: UsersListModelAccountsResult = {
      profileId: PROFILE_ID,
      accounts: [
        {
          authProfileId: ACCOUNT_ID,
          provider: "openai",
          label: "Work",
          authType: "oauth",
          selected: true,
        },
      ],
      nextCursor: ACCOUNT_ID,
      links: connected.links,
    };
    const output = runtime();
    await withGateway(
      ({ method }) => (method === "users.listModelAccounts" ? page : undefined),
      async ({ port, url, requests, connections }) => {
        await modelsAccountsListCommand({ port, cursor: "previous-account", json: true }, output);
        expect(requestData(requests)).toEqual([
          rpc("users.self"),
          rpc("users.listModelAccounts", { cursor: "previous-account" }),
        ]);
        expectJsonOutput(output, page);
        expectPersonalContext(output, url);
        expect(output.log).not.toHaveBeenCalled();
        expect(connections).toHaveLength(1);
        expect(connections[0]?.params).toMatchObject({
          device: { nonce: "test-nonce" },
          scopes: ["operator.read"],
        });
      },
    );
  });

  it("uses a credential-free explicit URL without leaking ambient, configured, or other-edge auth", async () => {
    const page = {
      profileId: PROFILE_ID,
      accounts: [],
      links: [],
    } satisfies UsersListModelAccountsResult;
    const output = runtime();
    await withGateway(
      ({ method }) => (method === "users.listModelAccounts" ? page : undefined),
      async ({ url, requests, connections, upgradeHeaders }) => {
        await modelsAccountsListCommand({ url, json: true }, output);
        expect(methods(requests)).toEqual(["users.self", "users.listModelAccounts"]);
        expect(connections).toHaveLength(1);
        expect(connections[0]?.params.auth).toBeUndefined();
        expect(upgradeHeaders[0]?.["x-edge-auth"]).toBeUndefined();
        expectPersonalContext(output, url);
        expectJsonOutput(output, page);
      },
      {
        env: {
          OPENCLAW_GATEWAY_TOKEN: "ambient-shared-token",
          OPENCLAW_GATEWAY_PASSWORD: "ambient-shared-password",
        },
        config: {
          gateway: {
            mode: "remote",
            auth: { mode: "token", token: "configured-local-token" },
            remote: {
              url: "wss://different-gateway.example/control",
              token: "configured-remote-token",
              password: "configured-remote-password",
              edgeAuth: { "X-Edge-Auth": "configured-other-edge-token" },
            },
          },
        },
      },
    );
  });

  it.each([
    {
      run: (port: string, output: ReturnType<typeof runtime>) =>
        modelsAccountsUpdateDefaultCommand(
          { port, action: "use", authProfileId: ACCOUNT_ID },
          output,
        ),
      method: "users.selectModelAccount",
      params: { profileId: PROFILE_ID, authProfileId: ACCOUNT_ID },
      note: "Existing sessions keep",
    },
    {
      run: (port: string, output: ReturnType<typeof runtime>) =>
        modelsAccountsUpdateDefaultCommand(
          { port, action: "clear-default", provider: "openai" },
          output,
        ),
      method: "users.unlinkAuthProfile",
      params: { profileId: PROFILE_ID, provider: "openai" },
      note: "Saved credentials and existing session accounts are unchanged",
    },
  ])(
    "binds $method to the authenticated person without changing sessions",
    async ({ run, method, params, note }) => {
      const output = runtime();
      await withGateway(
        (request) => (request.method === method ? { links: connected.links } : undefined),
        async ({ port, url, requests, connections }) => {
          await run(port, output);
          expect(requestData(requests)).toEqual([rpc("users.self"), rpc(method, params)]);
          expect(connections).toHaveLength(1);
          expectPersonalContext(output, url);
          expect(output.log).toHaveBeenCalledWith(expect.stringContaining(note));
        },
      );
    },
  );

  it("guides an unidentified person through login without prompting for provider credentials", async () => {
    const output = runtime();
    await withGateway(
      () => {
        throw new Error("unidentified");
      },
      async ({ port, requests }) => {
        await expect(login(port, output)).rejects.toThrow("require a signed-in person");
        expect(methods(requests)).toEqual(["users.self"]);
        expectNoPrompt();
      },
    );
  });

  it("uses Gateway provider/method choices and sends a hidden API key only as the exact step answer", async () => {
    const apiKey = "synthetic-personal-api-key";
    const invalidKey = "synthetic-invalid-key";
    const validationError =
      "That answer is not valid. Check the sign-in instructions and try again.";
    const keyStep = { id: "api-key", type: "text", message: "API key", sensitive: true } as const;
    let answers = 0;
    const output = runtime();
    const choices = {
      providers: [
        { id: "openai", label: "OpenAI", methods: [{ id: "oauth", label: "Browser" }] },
        {
          id: "xai",
          label: "Grok",
          methods: [
            { id: "api-key", label: "API key" },
            { id: "device-code", label: "Device code" },
          ],
        },
      ],
    } satisfies UsersAuthConnectCatalogResult;
    mocks.autocomplete.mockResolvedValueOnce("xai").mockResolvedValueOnce("api-key");
    await withAuthGateway(
      {
        catalog: () => choices,
        status: () => ({ status: "pending", step: keyStep }),
        answer: () =>
          ++answers === 1
            ? { status: "pending", step: keyStep, error: validationError }
            : { status: "connected", authProfileId: ACCOUNT_ID, links: [] },
      },
      async ({ port, url, requests, connections }) => {
        mocks.password.mockImplementation(async () => {
          expectPersonalContext(output, url);
          return answers === 0 ? invalidKey : apiKey;
        });
        await modelsAccountsLoginCommand({ port, json: true }, output);
        expect(requestData(requests)).toEqual([
          rpc("users.self"),
          authRpc("catalog", { profileId: PROFILE_ID }),
          authRpc("start", { profileId: PROFILE_ID, provider: "xai", method: "api-key" }),
          authRpc("status"),
          authRpc("answer", { ...operation, stepId: "api-key", value: invalidKey }),
          authRpc("answer", { ...operation, stepId: "api-key", value: apiKey }),
        ]);
        expect(connections).toHaveLength(1);
        expect(
          mocks.autocomplete.mock.calls.map(([prompt]) => {
            if (!Array.isArray(prompt.options)) {
              throw new Error("Expected static login choices");
            }
            return prompt.options.map(({ value }) => value);
          }),
        ).toEqual([
          ["openai", "xai"],
          ["api-key", "device-code"],
        ]);
        expect(mocks.password).toHaveBeenCalledTimes(2);
        expect(mocks.password).toHaveBeenCalledWith(
          expect.objectContaining({ output: process.stderr, signal: expect.any(AbortSignal) }),
        );
        expect(output.error).toHaveBeenCalledWith(validationError);
        expectLoginOutput(
          output,
          {
            status: "connected",
            authProfileId: ACCOUNT_ID,
            links: [],
          },
          "xai",
        );
        expect(printed(output)).not.toContain(apiKey);
        expect(printed(output)).not.toContain(invalidKey);
      },
    );
  });

  it("rejects an unavailable catalog selection before starting: Unknown sign-in method", async () => {
    await withGateway(
      () => undefined,
      async ({ port, requests }) => {
        await expect(
          modelsAccountsLoginCommand({ port, provider: "openai", method: "missing" }, runtime()),
        ).rejects.toThrow("Unknown sign-in method");
        expect(methods(requests)).toEqual(["users.self", "users.authConnect.catalog"]);
        expectNoPrompt();
      },
    );
  });

  it("rejects non-TTY sign-in without consuming input", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    await expect(modelsAccountsLoginCommand({ provider: "openai" }, runtime())).rejects.toThrow(
      "requires an interactive terminal",
    );
    expectNoPrompt();
  });

  it("renders the latest device progress snapshot and opens each destination once without acknowledging the code", async () => {
    const redirectInput =
      "http://localhost:1455/auth/callback?code=synthetic-private-code&state=synthetic-state";
    mocks.password.mockResolvedValue(redirectInput);
    const output = runtime();
    const verificationUrl = "https://auth.example/device";
    const code = "ABCD-1234";
    const progressUpdated = createDeferredCore();
    const continueToInput = createDeferredCore();
    const inputReady = createDeferredCore();
    const session = new WizardSession(async (prompter) => {
      const progress = prompter.progress("Starting provider sign-in");
      await prompter.openUrl?.(verificationUrl);
      await prompter.deviceCode?.({
        title: "Provider device sign-in",
        code,
        expiresInMinutes: 15,
        message: "Enter this one-time code on the provider's sign-in page.",
      });
      progress.update("Waiting for the initial provider poll");
      progress.update("Waiting for provider approval");
      progressUpdated.resolve();
      await continueToInput.promise;
      await prompter.openUrl?.(inputStep.externalUrl);
      const input = prompter.text({ message: inputStep.message, sensitive: true });
      inputReady.resolve();
      await input;
    });
    let polls = 0;
    let renderedProgress = "";
    let inputStepId: string | undefined;
    try {
      await withAuthGateway(
        {
          status: async () => {
            await progressUpdated.promise;
            polls += 1;
            if (polls === 3) {
              renderedProgress = output.error.mock.calls.map((args) => args.join(" ")).join("\n");
              continueToInput.resolve();
              await inputReady.promise;
            }
            const step = session.getCurrentStep();
            if (!step) {
              throw new Error("Expected the current WizardSession step.");
            }
            if (step.type === "text") {
              inputStepId = step.id;
            }
            return { status: "pending", step: sanitizeWizardStepForClient(step) };
          },
          answer: async ({ params }) => {
            if (typeof params.stepId !== "string") {
              throw new Error("Expected an exact wizard step ID.");
            }
            await session.answer(params.stepId, params.value);
            await session.whenSettled();
            return connected;
          },
        },
        async ({ port, requests, connections }) => {
          await login(port, output, true);
          expect(session.getStatus()).toBe("done");
          expect(inputStepId).toEqual(expect.any(String));
          expect(connections).toHaveLength(1);
          expect(new Set(requests.map(({ socket }) => socket)).size).toBe(1);
          expect(
            requests
              .filter(({ method }) => method === "users.authConnect.answer")
              .map(({ params }) => params),
          ).toEqual([
            {
              ...operation,
              stepId: inputStepId,
              value: redirectInput,
            },
          ]);
          expect(mocks.openUrl.mock.calls).toEqual([[verificationUrl], [inputStep.externalUrl]]);
          for (const message of [
            verificationUrl,
            `Code: ${code}`,
            "Code expires in 15 minutes.",
            "Enter this one-time code on the provider's sign-in page.",
            DEVICE_CODE_PHISHING_WARNING,
            "Waiting for provider approval",
          ]) {
            expect(renderedProgress).toContain(message);
          }
          expect(renderedProgress).not.toContain("Waiting for the initial provider poll");
          expect(requests.some(({ method }) => method === "users.authConnect.cancel")).toBe(false);
          expectLoginOutput(output, connected);
          expect(printed(output)).not.toContain("synthetic-private-code");
        },
      );
    } finally {
      session.cancel();
      continueToInput.resolve();
      await session.whenSettled();
    }
  });

  it("finishes from the authoritative failed status and closes the prompt", async () => {
    const result = {
      status: "failed",
      reason: "exchange",
    } satisfies UsersAuthConnectStatusResult;
    waitForPromptAbort();
    const output = runtime();
    let polls = 0;
    await withAuthGateway(
      { status: () => (++polls === 1 ? pendingInput : result) },
      async ({ port, requests }) => {
        await expect(login(port, output, true)).rejects.toMatchObject({ code: 1 });
        expect(mocks.password.mock.calls[0]?.[0].signal?.aborted).toBe(true);
        expect(
          requests.some(
            ({ method }) =>
              method === "users.authConnect.answer" || method === "users.authConnect.cancel",
          ),
        ).toBe(false);
        expectLoginOutput(output, result);
      },
    );
  });

  it("waits for exact cancellation acknowledgment before closing the initiating socket", async () => {
    mocks.password.mockResolvedValue(CANCEL_SYMBOL);
    const received = createDeferredCore<Request>();
    const acknowledged = createDeferredCore<UsersAuthConnectStatusResult>();
    const output = runtime();
    await withAuthGateway(
      {
        status: () => pendingInput,
        cancel: (request) => {
          received.resolve(request);
          return acknowledged.promise;
        },
      },
      async ({ port, connections }) => {
        const command = expect(login(port, output)).rejects.toMatchObject({ code: 130 });
        const request = await received.promise;
        expect(request.params).toEqual(operation);
        expect(request.socket.readyState).toBe(WebSocket.OPEN);
        expect(output.log).not.toHaveBeenCalled();
        acknowledged.resolve({ status: "cancelled" });
        await command;
        expect(connections).toHaveLength(1);
      },
    );
  });

  it("cancels a late start response after Ctrl-C instead of orphaning its operation id", async () => {
    const started = createDeferredCore();
    const response = createDeferredCore<UsersAuthConnectStartResult>();
    const onSignal = vi.spyOn(process, "once");
    await withAuthGateway(
      {
        start: () => {
          started.resolve();
          return response.promise;
        },
        cancel: () => ({ status: "cancelled" }),
      },
      async ({ port, requests, connections }) => {
        const command = expect(login(port)).rejects.toMatchObject({ code: 130 });
        await started.promise;
        const interrupt = onSignal.mock.calls.find(([event]) => event === "SIGINT")?.[1];
        if (!interrupt) {
          throw new Error("Expected the command's signal handler.");
        }
        interrupt("SIGINT");
        response.resolve(startResult());
        await command;
        expect(methods(requests)).toEqual([
          "users.self",
          "users.authConnect.catalog",
          "users.authConnect.start",
          "users.authConnect.cancel",
        ]);
        expect(requests.at(-1)?.params).toEqual(operation);
        expect(connections).toHaveLength(1);
        expectNoPrompt();
      },
    );
  });

  it("stops on connection loss and never carries the operation to another socket", async () => {
    waitForPromptAbort();
    let polls = 0;
    await withAuthGateway(
      {
        status: ({ socket }) => {
          if (++polls === 1) {
            return pendingInput;
          }
          socket.close(1001, "gone");
          return undefined;
        },
      },
      async ({ port, requests, connections }) => {
        await expect(login(port)).rejects.toThrow("Could not confirm sign-in cancellation");
        expect(connections).toHaveLength(1);
        expect(new Set(requests.map(({ socket }) => socket)).size).toBe(1);
        expect(mocks.password.mock.calls[0]?.[0].signal?.aborted).toBe(true);
      },
    );
  });
});
