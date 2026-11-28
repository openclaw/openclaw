import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
/* @vitest-environment jsdom */
import { sessionRequest as mockSessionRequests } from "../../lib/sessions/hydration-family.test-support.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  createContext,
  createLiveSessionContext,
  createGateway,
  createRenderedPage,
  createSessions,
} from "./sessions-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
const archived = (key: string): GatewaySessionRow => ({ key, kind: "direct", archived: true });
function writeContext(sessions: SessionCapability) {
  const connection = createGateway({} as GatewayBrowserClient);
  connection.emit({
    hello: gatewayHelloForMethods(["sessions.delete"], ["operator.read", "operator.write"]),
  });
  return createContext(connection.gateway, sessions);
}
async function mount(
  sessions: SessionCapability,
  rows: GatewaySessionRow[],
  deepLink: string | null = null,
) {
  const context = writeContext(sessions);
  context.agentSelection.state.scopeId = null;
  return createRenderedPage(context, sessionsResult(rows, 1), "archived", deepLink);
}
beforeEach(() => {
  vi.mocked(showConfirmDialog).mockReset().mockResolvedValue(true);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
});
describe("sessions page archived deletion", () => {
  it("optimistically removes a selection and restores the row and checkbox on rejection", async () => {
    const target = {
      ...archived("agent:main:cloud"),
      sessionId: "cloud-id",
    };
    const response = createDeferred<{ deleted: boolean }>();
    const request = mockSessionRequests({
      "sessions.delete": () => response.promise,
      "sessions.list": () => sessionsResult([target]),
      "sessions.subscribe": () => ({ subscribed: true }),
    });
    const { sessions, context } = createLiveSessionContext({
      request,
    } as unknown as GatewayBrowserClient);
    onTestFinished(() => sessions.dispose());
    const page = await createRenderedPage(context, sessionsResult([target]), "archived");
    await sessions.refreshList({ agentId: "main", archivedFilter: "archived" });
    const checkbox = () =>
      page.querySelector<HTMLInputElement>(`input[aria-label="Select session: ${target.key}"]`);
    expect(checkbox()).not.toBeNull();
    checkbox()!.click();
    await page.updateComplete;
    const operation = page.deleteSessionFromMenu(target);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "sessions.delete",
        expect.objectContaining({ key: target.key }),
        { timeoutMs: 10 * 60_000 },
      ),
    );
    expect(page.result?.sessions).toEqual([]);
    const failure = new Error("cloud cleanup failed");
    response.reject(failure);
    await operation;
    expect(page.result?.sessions.map(({ key }) => key)).toContain(target.key);
    expect(page.error).toBe(failure);
    await page.updateComplete;
    expect(checkbox()?.checked).toBe(true);
    expect(request.mock.calls.map(([method]) => method)).not.toContain("sessions.patch");
    expect(request.mock.calls.map(([method]) => method)).not.toContain("sessions.patchMany");
  });

  it("does not let a write-scoped operator delete an active session", async () => {
    const target = { ...archived("agent:main:active"), archived: false };
    const sessions = createSessions();
    const page = await createRenderedPage(writeContext(sessions), sessionsResult([target], 1));
    await page.deleteSessionFromMenu(target);
    expect(sessions.deleteMany).not.toHaveBeenCalled();
    expect(page.error).toBe("You don’t have permission to do this.");
  });

  it("enumerates beyond a deep link and recovers moved rows without double deletion", async () => {
    const keys = ["agent:main:first", "agent:writer:repeated", "agent:writer:moved"];
    const listed = (indices: number[], more = false) => ({
      ...sessionsResult(indices.map((index) => archived(keys[index]!))),
      totalCount: 3,
      hasMore: more,
      nextOffset: more ? 2 : null,
    });
    const list = vi
      .fn<SessionCapability["list"]>()
      .mockResolvedValueOnce(listed([0, 1], true))
      .mockResolvedValueOnce(listed([1]))
      .mockResolvedValueOnce(listed([0, 1, 2]));
    const sessions = createSessions({
      list,
      deleteMany: vi.fn(async () => ({ deleted: keys, errors: [], preservedWorktrees: [] })),
    });
    const page = await mount(sessions, [archived(keys[0]!)], keys[0]!);
    page.querySelector<HTMLButtonElement>(".settings-section__actions .danger")!.click();
    await vi.waitFor(() => expect(sessions.deleteMany).toHaveBeenCalledOnce());
    expect(list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ offset: 2, limit: 1000, archivedFilter: "archived" }),
    );
    expect(list.mock.calls[0]![0]).not.toHaveProperty("search");
    expect(list.mock.calls[0]![0]).not.toHaveProperty("agentId");
    expect(showConfirmDialog).toHaveBeenCalledOnce();
    expect(sessions.deleteMany).toHaveBeenCalledWith(
      keys.map((key) => ({
        key,
        agentId: undefined,
        deleteTranscript: true,
        archivedOnly: true,
      })),
    );
  });

  it.each([
    [
      "missing page",
      "OpenClaw couldn’t load the list of archived sessions, so it didn’t delete any.",
    ],
    [
      "stalled page",
      "OpenClaw couldn’t load the next page of archived sessions, so it didn’t delete any.",
    ],
    ["incomplete list", "OpenClaw couldn’t list every archived session, so it didn’t delete any."],
    ["request error", "List unavailable"],
  ] as const)(
    "explains %s before confirming or deleting archived sessions",
    async (cause, message) => {
      const target = archived("agent:main:only-visible");
      const failure = new Error(message);
      const list = vi.fn<SessionCapability["list"]>(async (options) => {
        if (cause === "request error") {
          throw failure;
        }
        if (cause === "missing page") {
          return null;
        }
        return {
          ...sessionsResult([target], 1),
          ...(options?.offset ? {} : { totalCount: 2 }),
          hasMore: !options?.offset,
          nextOffset: cause === "stalled page" ? 0 : options?.offset ? null : 1,
        };
      });
      const sessions = createSessions({ list });
      const page = await mount(sessions, [target]);
      await page.deleteAllArchived();
      await page.updateComplete;
      expect(page.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
        cause === "request error"
          ? message
          : `${message} To try again, choose Delete all archived in Filters.`,
      );
      if (cause === "request error") {
        expect(page.error).toBe(failure);
      }
      expect(showConfirmDialog).not.toHaveBeenCalled();
      expect(sessions.deleteMany).not.toHaveBeenCalled();
    },
  );
});
