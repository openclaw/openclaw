import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  buildAgentMainSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { createContext } from "../skill-workshop/skill-workshop-page.test-support.ts";
import { ClawCreatorFlow } from "./creator-flow.ts";

vi.mock("../../lib/toast.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/toast.ts")>()),
  showToast: vi.fn(() => true),
}));

const draftId = "ec8f46b0-4ca3-4991-8a73-dfdcc8764087";
const scope = {
  input: "A public repository",
  job: "Summarize releases",
  output: "A release brief",
  authority: "Read public sources only",
};

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.mocked(showToast).mockClear();
});

describe("Create Claw from the agent's main chat", () => {
  it("invokes the bundled skill in the existing main session, then reviews and publishes the selected archive", async () => {
    vi.useFakeTimers();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      switch (method) {
        case "claws.drafts.create":
          return {
            draftId,
            prompt: "$create-claw Create a Claw from this agent and turn it into a shareable Claw.",
          };
        case "chat.send":
          return { status: "started", runId: "run-1" };
        case "claws.drafts.read":
          return { revision: "a".repeat(64), content: JSON.stringify({ scope }) };
        case "claws.drafts.review": {
          const choices = params.choices as
            | { name: string; description: string; excluded: string[] }
            | undefined;
          return {
            revision: "a".repeat(64),
            reviewToken: choices?.excluded.length ? "c".repeat(64) : "b".repeat(64),
            publisher: "maker",
            name: `@maker/${choices?.name ?? "release-brief"}`,
            version: "0.1.0",
            description: choices?.description ?? "Summarizes releases",
            items: [
              {
                id: "file:workspace/checklist.md",
                kind: "file",
                label: "workspace/checklist.md",
                detail: "Check sources",
                included: !choices?.excluded.includes("file:workspace/checklist.md"),
              },
            ],
            files: [{ path: "CLAW.md", content: "Portable instructions" }],
            scope,
          };
        }
        case "claws.drafts.publish":
          return {
            name: "@maker/release-brief",
            version: "0.1.0",
            url: "https://clawhub.ai/packages/%40maker%2Frelease-brief",
            publicationStatus: "pending",
          };
        default:
          throw new Error(`Unexpected method ${method}`);
      }
    });
    const context = createContext(request);
    const flow = new ClawCreatorFlow(context);
    await flow.start("research");
    const mainKey = buildAgentMainSessionKey({
      agentId: "research",
      mainKey: resolveUiConfiguredMainKey({
        agentsList: context.agents.state.agentsList,
        hello: context.gateway.snapshot.hello,
      }),
    });
    expect(requests.map((entry) => entry.method)).toEqual(["claws.drafts.create", "chat.send"]);
    expect(requests[1]!.params).toMatchObject({ sessionKey: mainKey, deliver: false });
    expect(requests[1]!.params.workContext).toMatchObject({
      page: "claw-create",
      detail: { draftId },
    });
    expect(requests[1]!.params.message).toBe(
      "$create-claw Create a Claw from this agent and turn it into a shareable Claw.",
    );
    expect(requests[1]!.params.message).not.toContain(draftId);
    expect(requests[1]!.params.message).not.toContain("Review:");
    expect(requests[1]!.params).not.toHaveProperty("parentSessionKey");
    expect(requests[1]!.params).not.toHaveProperty("fork");
    expect(context.navigate).toHaveBeenCalledWith("chat", expect.anything());

    await vi.advanceTimersByTimeAsync(2500);
    expect(flow.modalOpen).toBe(true);
    expect(flow.reviewCurrent).toBe(true);
    flow.updateChoices({
      name: "release-brief",
      description: "Summarizes releases",
      excluded: ["file:workspace/checklist.md"],
    });
    expect(flow.reviewCurrent).toBe(false);
    await vi.advanceTimersByTimeAsync(350);
    expect(flow.reviewCurrent).toBe(true);
    await flow.publish();
    expect(flow.modalOpen).toBe(false);
    expect(flow.publication?.publicationStatus).toBe("pending");
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Submitted to ClawHub. Publication pending security review.",
        actionLabel: "View on ClawHub",
        onAction: expect.any(Function),
      }),
    );
    expect(requests.at(-1)).toMatchObject({
      method: "claws.drafts.publish",
      params: {
        reviewToken: "c".repeat(64),
        choices: { excluded: ["file:workspace/checklist.md"] },
      },
    });
    expect(requests.some((entry) => entry.method === "sessions.create")).toBe(false);
  });

  it("keeps overlapping skill turns bound to their own draft ids", async () => {
    vi.useFakeTimers();
    const ids = {
      research: "ec8f46b0-4ca3-4991-8a73-dfdcc8764087",
      writer: "ed9f46b0-4ca3-4991-8a73-dfdcc8764088",
    };
    const createResolvers = new Map<string, (value: unknown) => void>();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const request = vi.fn((method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === "claws.drafts.create") {
        return new Promise((resolve) => {
          createResolvers.set(params.agentId as string, resolve);
        });
      }
      if (method === "chat.send") {
        return Promise.resolve({ status: "started" });
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const context = createContext(request);
    const researchFlow = new ClawCreatorFlow(context);
    const writerFlow = new ClawCreatorFlow(context);

    const researchStart = researchFlow.start("research");
    const writerStart = writerFlow.start("writer");
    expect(createResolvers.size).toBe(2);

    // Resolve in reverse order to prove IDs travel with each specific request.
    createResolvers.get("writer")!({
      draftId: ids.writer,
      prompt: "$create-claw Create a Claw from this agent and turn it into a shareable Claw.",
    });
    createResolvers.get("research")!({
      draftId: ids.research,
      prompt: "$create-claw Create a Claw from this agent and turn it into a shareable Claw.",
    });
    await Promise.all([researchStart, writerStart]);

    const sends = requests.filter((entry) => entry.method === "chat.send");
    expect(sends).toHaveLength(2);
    const attachedIds = sends.map((entry) => {
      const workContext = entry.params.workContext as { detail: { draftId: string } };
      return workContext.detail.draftId;
    });
    expect(attachedIds.toSorted()).toEqual([ids.research, ids.writer].toSorted());
    for (const send of sends) {
      const workContext = send.params.workContext as {
        agentId: string;
        detail: { draftId: string };
      };
      expect(workContext.detail.draftId).toBe(ids[workContext.agentId as keyof typeof ids]);
      expect(send.params.message).not.toContain(workContext.detail.draftId);
    }
  });

  it.each(["claws.drafts.create", "chat.send"])(
    "can start again after a client change interrupts %s",
    async (pendingMethod) => {
      vi.useFakeTimers();
      let resolvePending!: (value: unknown) => void;
      const oldRequest = vi.fn((method: string) => {
        if (method === pendingMethod) {
          return new Promise((resolve) => {
            resolvePending = resolve;
          });
        }
        if (method === "claws.drafts.create") {
          return Promise.resolve({
            draftId,
            prompt: "$create-claw Create a Claw from this agent and turn it into a shareable Claw.",
          });
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const context = createContext(oldRequest);
      const listeners = new Set<(snapshot: typeof context.gateway.snapshot) => void>();
      context.gateway.subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      const flow = new ClawCreatorFlow(context);
      const interrupted = flow.start("research");
      await Promise.resolve();
      await Promise.resolve();
      expect(oldRequest).toHaveBeenCalledWith(pendingMethod, expect.anything());
      expect(flow.busy).toBe("starting");

      const newRequest = vi.fn(async (method: string) => {
        if (method === "claws.drafts.create") {
          return {
            draftId,
            prompt: "$create-claw Create a Claw from this agent and turn it into a shareable Claw.",
          };
        }
        if (method === "chat.send") {
          return { status: "started" };
        }
        throw new Error(`Unexpected method ${method}`);
      });
      Object.assign(context.gateway.snapshot, {
        client: { request: newRequest } as unknown as GatewayBrowserClient,
      });
      for (const listener of listeners) {
        listener(context.gateway.snapshot);
      }
      expect(flow.busy).toBeNull();

      await flow.start("research");
      expect(newRequest).toHaveBeenCalledWith("chat.send", expect.anything());
      resolvePending(
        pendingMethod === "chat.send"
          ? { status: "started" }
          : {
              draftId,
              prompt:
                "$create-claw Create a Claw from this agent and turn it into a shareable Claw.",
            },
      );
      await interrupted;
      expect(flow.busy).toBeNull();
    },
  );

  it("surfaces a failed start on agent settings with a retry action", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "claws.drafts.create") {
        throw new Error("The agent workspace is unavailable");
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const context = createContext(request);
    const flow = new ClawCreatorFlow(context);
    await flow.start("research");

    expect(flow.busy).toBeNull();
    expect(flow.hasActiveDraft).toBe(false);
    expect(context.navigate).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "The agent workspace is unavailable",
        actionLabel: "Retry",
        onAction: expect.any(Function),
      }),
    );
  });
});
