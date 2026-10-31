import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import {
  createContext,
  createRuntimeConfigStub,
} from "../skill-workshop/skill-workshop-page.test-support.ts";

const { toast } = vi.hoisted(() => ({
  toast: vi.fn<(options: import("../../lib/toast.ts").ToastOptions) => boolean>(() => true),
}));
vi.mock("../../lib/toast.ts", async (original) => ({
  ...(await original<typeof import("../../lib/toast.ts")>()),
  showToast: toast,
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.doUnmock("./creator-flow.ts");
  vi.clearAllTimers();
  vi.useRealTimers();
  toast.mockClear();
});

async function fixture() {
  const ready = Promise.withResolvers<void>();
  const importing = Promise.withResolvers<void>();
  vi.doMock("./creator-flow.ts", async () => {
    importing.resolve();
    await ready.promise;
    return vi.importActual<typeof import("./creator-flow.ts")>("./creator-flow.ts");
  });
  const request = vi.fn(async (method: string) => {
    if (method === "templates.drafts.create") {
      return { draftId: "draft-a", prompt: "Create a shareable Template" };
    }
    if (method === "chat.send") {
      return { status: "started" };
    }
    throw new Error(`Unexpected RPC ${method}`);
  });
  const context = createContext(request, {
    methods: ["templates.drafts.create", "chat.send"],
    runtimeConfig: createRuntimeConfigStub({
      sourceConfig: { gateway: { controlUi: { experimental: { templates: true } } } },
    }),
  });
  Object.assign(context.gateway, { connectionRevision: 0 });
  const listeners = new Set<(snapshot: typeof context.gateway.snapshot) => void>();
  context.gateway.subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const { templateCreatorAction } = await import("./creator-owner.ts");
  const { templateCreatorOwner } = await import("./creator-publication.ts");
  const owner = templateCreatorOwner(context);
  return {
    context,
    request,
    owner,
    ready,
    importing: importing.promise,
    action: (agentId = "research") => templateCreatorAction(context, agentId)!(),
    connect: (handler: GatewayRequestHandler = request) => {
      context.gateway.snapshot.client = createTestGatewayClient(handler);
      Object.assign(context.gateway, {
        connectionRevision: context.gateway.connectionRevision + 1,
      });
      for (const listener of listeners) {
        listener(context.gateway.snapshot);
      }
    },
    settled: () => vi.waitFor(() => expect(owner.pending).toBeNull()),
  };
}

function replaceWaitingConnections(f: Awaited<ReturnType<typeof fixture>>) {
  const retired = [];
  for (let index = 0; index < 8; index++) {
    retired.push(new WeakRef(f.context.gateway.snapshot.client!));
    f.connect();
    f.action(`agent-${index}`);
  }
  return { retired, unowned: new WeakRef({ control: true }) };
}

it("releases superseded clients before a held import settles and starts only the latest target", async () => {
  const f = await fixture();
  f.action();
  await f.importing;
  const { retired, unowned } = replaceWaitingConnections(f);
  const current = new WeakRef(f.context.gateway.snapshot.client!);
  try {
    await collectGarbageForTest();
    expect(unowned.deref()).toBeUndefined();
    expect(current.deref()).toBeDefined();
    expect(retired.every((client) => client.deref() === undefined)).toBe(true);
    expect(f.request).not.toHaveBeenCalled();
  } finally {
    f.ready.resolve();
    await vi.dynamicImportSettled();
  }
  await vi.waitFor(() => expect(f.context.navigate).toHaveBeenCalledOnce());
  expect(f.request).toHaveBeenCalledWith("templates.drafts.create", { agentId: "agent-7" });
  expect(
    f.request.mock.calls.filter(([method]) => method === "templates.drafts.create"),
  ).toHaveLength(1);
});

it("reserves the first clicked agent before import, then navigates only after send acknowledgement", async () => {
  const f = await fixture();
  expect(f.owner.flow).toBeNull();
  const acknowledged = Promise.withResolvers<{ status: string }>();
  f.request.mockImplementation(async (method) =>
    method === "chat.send"
      ? acknowledged.promise
      : { draftId: "draft-a", prompt: "Create a shareable Template" },
  );
  f.action();
  f.action("writer");
  await f.importing;
  f.context.agentSelection.set("writer");
  expect(f.request).not.toHaveBeenCalled();
  f.ready.resolve();
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith("chat.send", expect.anything()));
  expect(f.request).toHaveBeenCalledWith("templates.drafts.create", { agentId: "research" });
  expect(
    f.request.mock.calls.filter(([method]) => method === "templates.drafts.create"),
  ).toHaveLength(1);
  expect(f.context.navigate).not.toHaveBeenCalled();
  acknowledged.resolve({ status: "started" });
  await vi.waitFor(() => expect(f.context.navigate).toHaveBeenCalledOnce());
  expect(f.owner.flow?.hasActiveDraft).toBe(true);
});

it.each(["client", "revision", "disconnected", "create", "send", "Lab"])(
  "rejects a held import after %s authority changes, then permits a fresh attempt",
  async (change) => {
    const f = await fixture();
    f.action();
    await f.importing;
    const { snapshot } = f.context.gateway;
    const client = snapshot.client;
    const hello = snapshot.hello;
    if (change === "client") {
      snapshot.client = null;
    } else if (change === "revision") {
      Object.assign(f.context.gateway, { connectionRevision: 1 });
    } else if (change === "disconnected") {
      snapshot.phase = "reconnecting";
    } else if (change === "Lab") {
      Object.assign(f.context.runtimeConfig.state.configSnapshot!, {
        sourceConfig: { gateway: { controlUi: { experimental: { templates: false } } } },
      });
    } else {
      snapshot.hello = {
        ...hello!,
        features: { methods: change === "create" ? ["chat.send"] : ["templates.drafts.create"] },
      };
    }
    f.ready.resolve();
    await f.settled();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.owner.flow).toBeNull();
    Object.assign(snapshot, { client, hello, phase: "connected" });
    Object.assign(f.context.runtimeConfig.state.configSnapshot!, {
      sourceConfig: { gateway: { controlUi: { experimental: { templates: true } } } },
    });
    f.action();
    await vi.waitFor(() => expect(f.context.navigate).toHaveBeenCalledOnce());
  },
);

it("does not release a successor connection's reservation when the old import settles", async () => {
  const f = await fixture();
  f.action();
  await f.importing;
  const old = f.owner.pending;
  Object.assign(f.context.gateway, { connectionRevision: 1 });
  f.action("writer");
  expect(f.owner.pending).not.toBe(old);
  f.ready.resolve();
  await vi.waitFor(() => expect(f.context.navigate).toHaveBeenCalledOnce());
  expect(f.request).toHaveBeenCalledWith("templates.drafts.create", { agentId: "writer" });
  expect(
    f.request.mock.calls.filter(([method]) => method === "templates.drafts.create"),
  ).toHaveLength(1);
});

it("admits a successor connection while the old flow's issued write is still pending", async () => {
  const f = await fixture();
  const oldWrite = Promise.withResolvers<Awaited<ReturnType<typeof f.request>>>();
  f.request.mockImplementation(() => oldWrite.promise);
  f.action();
  f.ready.resolve();
  await vi.waitFor(() =>
    expect(f.request).toHaveBeenCalledWith("templates.drafts.create", expect.anything()),
  );
  const successor = vi.fn(async (method: string) =>
    method === "templates.drafts.create"
      ? { draftId: "draft-b", prompt: "Create a shareable Template" }
      : { status: "started" },
  );
  f.connect(successor);
  f.action("writer");
  await vi.waitFor(() => expect(f.context.navigate).toHaveBeenCalledOnce());
  expect(successor).toHaveBeenCalledWith("templates.drafts.create", { agentId: "writer" });
  oldWrite.resolve({ draftId: "old-draft", prompt: "Old prompt" });
  await vi.dynamicImportSettled();
  expect(f.request).toHaveBeenCalledOnce();
  expect(f.context.navigate).toHaveBeenCalledOnce();
});

it.each(["open", "start"])(
  "shares the direct route flow and preserves its newer %s intent",
  async (intent) => {
    const f = await fixture();
    f.action();
    await f.importing;
    const { templateCreatorFlow } =
      await vi.importActual<typeof import("./creator-flow.ts")>("./creator-flow.ts");
    const direct = templateCreatorFlow(f.context);
    if (intent === "open") {
      direct.open("writer", "existing-draft");
    } else {
      await direct.start("writer");
    }
    expect(f.owner.flow).toBe(direct);
    expect(templateCreatorFlow(f.context)).toBe(direct);
    f.ready.resolve();
    await vi.dynamicImportSettled();
    await f.settled();
    expect(f.context.navigate).toHaveBeenCalledOnce();
    expect(f.request.mock.calls.filter(([method]) => method === "templates.drafts.create")).toEqual(
      intent === "open" ? [] : [["templates.drafts.create", { agentId: "writer" }]],
    );
  },
);

it("shows a rejected import and retries the latest connection's clicked target", async () => {
  const f = await fixture();
  f.action();
  await f.importing;
  f.connect();
  f.action("writer");
  f.connect();
  f.action("reviewer");
  f.ready.reject(new Error("Creator module unavailable"));
  await f.settled();
  expect(f.request).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining("Creator module unavailable"),
      actionLabel: "Retry",
      onAction: expect.any(Function),
    }),
  );
  vi.doUnmock("./creator-flow.ts");
  const action = toast.mock.calls[0]?.[0];
  action!.onAction!();
  await vi.waitFor(() => expect(f.context.navigate).toHaveBeenCalledOnce());
  expect(f.request).toHaveBeenCalledWith("templates.drafts.create", { agentId: "reviewer" });
});
