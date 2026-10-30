import type { TemplateDraftReviewChoices } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { showToast } from "../../lib/toast.ts";
import { createContext } from "../skill-workshop/skill-workshop-page.test-support.ts";
import { TemplateCreatorFlow } from "./creator-flow.ts";

vi.mock("../../lib/toast.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/toast.ts")>()),
  showToast: vi.fn(() => true),
}));

const draftId = "ec8f46b0-4ca3-4991-8a73-dfdcc8764087";
const prompt =
  "$create-template Create a Template from this agent and turn it into a shareable Template.";
const createdDraft = (id = draftId) => ({ draftId: id, prompt });
function startResult(method: string) {
  if (method === "templates.drafts.create") {
    return createdDraft();
  }
  if (method === "chat.send") {
    return { status: "started" };
  }
  throw new Error(`Unexpected method ${method}`);
}
function expectToast(message: string, actionLabel: string) {
  expect(showToast).toHaveBeenCalledWith(
    expect.objectContaining({ message, actionLabel, onAction: expect.any(Function) }),
  );
}
const scope = {
  input: "A public repository",
  job: "Summarize releases",
  output: "A release brief",
  authority: "Read public sources only",
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.mocked(showToast).mockClear();
});

it("invokes the bundled skill in the existing main session, then reviews and publishes the selected archive", async () => {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "templates.drafts.read":
        return { revision: "a".repeat(64), content: JSON.stringify({ scope }) };
      case "templates.drafts.review": {
        const choices = params.choices as TemplateDraftReviewChoices | undefined;
        return {
          revision: "a".repeat(64),
          reviewToken: choices?.excluded.length ? "c".repeat(64) : "b".repeat(64),
          publisher: "maker",
          name: `@maker/${choices?.name ?? "release-brief"}`,
          displayName: choices?.displayName ?? "Release Brief",
          version: "0.1.0",
          description: choices?.description ?? "Summarizes releases",
          items: [
            {
              id: "file:workspace/checklist.md",
              kind: "file",
              label: "workspace/checklist.md",
              included: !choices?.excluded.includes("file:workspace/checklist.md"),
            },
          ],
          files: [{ path: "CLAW.md", content: "Portable instructions" }],
          scope,
        };
      }
      case "templates.drafts.publish":
        return {
          name: "@maker/release-brief",
          version: "0.1.0",
          url: "https://clawhub.ai/packages/%40maker%2Frelease-brief",
          publicationStatus: "pending",
        };
      default:
        return startResult(method);
    }
  });
  const context = createContext(request);
  const flow = new TemplateCreatorFlow(context);
  await flow.start("research");
  const calls = request.mock.calls;
  expect(calls.map(([method]) => method)).toEqual(["templates.drafts.create", "chat.send"]);
  const sent = calls[1]![1];
  expect(sent).toMatchObject({
    sessionKey: "agent:research:main",
    deliver: false,
    workContext: { page: "template-create", detail: { draftId } },
    message: prompt,
  });
  expect(sent).not.toHaveProperty("parentSessionKey");
  expect(sent).not.toHaveProperty("fork");
  expect(context.navigate).toHaveBeenCalledWith("chat", expect.anything());

  await vi.advanceTimersByTimeAsync(2500);
  expect(flow).toMatchObject({ modalOpen: true, reviewCurrent: true });
  const choices = {
    name: "release-brief",
    displayName: "Research Brief",
    description: "Summarizes releases",
    excluded: ["file:workspace/checklist.md"],
  };
  flow.updateChoices(choices);
  expect(flow.reviewCurrent).toBe(false);
  await vi.advanceTimersByTimeAsync(350);
  expect(flow.reviewCurrent).toBe(true);
  await flow.publish();
  expect(flow).toMatchObject({ modalOpen: false, publication: { publicationStatus: "pending" } });
  expectToast("Submitted to ClawHub. Publication pending security review.", "View on ClawHub");
  expect(request.mock.lastCall).toEqual([
    "templates.drafts.publish",
    expect.objectContaining({ reviewToken: "c".repeat(64), choices }),
  ]);
  expect(calls.some(([method]) => method === "sessions.create")).toBe(false);
});

it("keeps overlapping skill turns bound to their own draft ids", async () => {
  const ids = {
    research: draftId,
    writer: "ed9f46b0-4ca3-4991-8a73-dfdcc8764088",
  };
  const createResolvers = new Map<string, (value: unknown) => void>();
  const request = vi.fn((method: string, params: Record<string, unknown>) => {
    if (method === "templates.drafts.create") {
      return new Promise((resolve) => {
        createResolvers.set(params.agentId as string, resolve);
      });
    }
    if (method === "chat.send") {
      return Promise.resolve(startResult(method));
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const context = createContext(request);
  const researchStart = new TemplateCreatorFlow(context).start("research");
  const writerStart = new TemplateCreatorFlow(context).start("writer");
  expect(createResolvers.size).toBe(2);

  // Resolve in reverse order to prove IDs travel with each specific request.
  createResolvers.get("writer")!(createdDraft(ids.writer));
  createResolvers.get("research")!(createdDraft(ids.research));
  await Promise.all([researchStart, writerStart]);

  expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(2);
  for (const [agentId, id] of Object.entries(ids)) {
    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        workContext: expect.objectContaining({ agentId, detail: { draftId: id } }),
        message: prompt,
      }),
    );
  }
});

it.each(["templates.drafts.create", "chat.send"])(
  "can start again after a client change interrupts %s",
  async (pendingMethod) => {
    const pending = Promise.withResolvers<unknown>();
    const oldRequest = vi.fn((method: string) => {
      if (method === pendingMethod) {
        return pending.promise;
      }
      if (method === "templates.drafts.create") {
        return Promise.resolve(createdDraft());
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const context = createContext(oldRequest);
    const listeners = new Set<(snapshot: typeof context.gateway.snapshot) => void>();
    context.gateway.subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const flow = new TemplateCreatorFlow(context);
    const interrupted = flow.start("research");
    await Promise.resolve();
    await Promise.resolve();
    expect(oldRequest).toHaveBeenCalledWith(pendingMethod, expect.anything());
    expect(flow.busy).toBe("starting");

    const newRequest = vi.fn(async (method: string) => startResult(method));
    Object.assign(context.gateway.snapshot, {
      client: { request: newRequest } as unknown as GatewayBrowserClient,
    });
    for (const listener of listeners) {
      listener(context.gateway.snapshot);
    }
    expect(flow.busy).toBeNull();

    await flow.start("research");
    expect(newRequest).toHaveBeenCalledWith("chat.send", expect.anything());
    pending.resolve(startResult(pendingMethod));
    await interrupted;
    expect(flow.busy).toBeNull();
  },
);

it("surfaces a failed start on agent settings with a retry action", async () => {
  const request = vi.fn(async (method: string) => {
    if (method === "templates.drafts.create") {
      throw new Error("The agent workspace is unavailable");
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const context = createContext(request);
  const flow = new TemplateCreatorFlow(context);
  await flow.start("research");

  expect(flow).toMatchObject({ busy: null, hasActiveDraft: false });
  expect(context.navigate).not.toHaveBeenCalled();
  expectToast("The agent workspace is unavailable", "Retry");
});
