/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  createContext,
  createGateway,
  createRenderedPage,
  createSessions,
} from "./sessions-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
const archived = (key: string): GatewaySessionRow => ({ key, kind: "direct", archived: true });
async function mount(
  sessions: SessionCapability,
  rows: GatewaySessionRow[],
  deepLink: string | null = null,
) {
  const connection = createGateway({} as GatewayBrowserClient);
  connection.emit({
    hello: gatewayHelloForMethods(["sessions.delete"], ["operator.read", "operator.write"]),
  });
  const context = createContext(connection.gateway, sessions);
  context.agentSelection.state.scopeId = null;
  return createRenderedPage(context, sessionsResult(rows, 1), "archived", deepLink);
}
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
      label: "Cloud thread",
      updatedAt: 1,
    };
    const response = createDeferred<{ deleted: boolean }>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.delete") {
        return response.promise;
      }
      if (method === "sessions.list") {
        return sessionsResult([target], 1);
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      return {};
    });
    const { gateway } = createGateway({ request } as unknown as GatewayBrowserClient);
    const sessions = createTestSessionCapability(gateway);
    onTestFinished(() => sessions.dispose());
    const page = await createRenderedPage(
      createContext(gateway, sessions),
      sessionsResult([target], 1),
      "archived",
    );
    await sessions.refreshList({ agentId: "main", archivedFilter: "archived" });
    const checkbox = () =>
      page.querySelector<HTMLInputElement>(`input[aria-label="Select session: ${target.key}"]`);
    expect(checkbox()).not.toBeNull();
    checkbox()!.click();
    await page.updateComplete;
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const operation = page.deleteSessionFromMenu(target);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "sessions.delete",
        expect.objectContaining({ key: target.key }),
        { timeoutMs: 10 * 60_000 },
      ),
    );
    expect(page.result?.sessions).toEqual([]);
    response.reject(new Error("cloud cleanup failed"));
    await operation;
    expect(page.result?.sessions.map(({ key }) => key)).toContain(target.key);
    expect(page.error).toContain("cloud cleanup failed");
    await page.updateComplete;
    expect(checkbox()?.checked).toBe(true);
  });

  it("does not let a write-scoped operator delete an active session", async () => {
    const target = { ...archived("agent:main:active"), archived: false };
    const sessions = createSessions();
    const connection = createGateway({} as GatewayBrowserClient);
    connection.emit({
      hello: gatewayHelloForMethods(["sessions.delete"], ["operator.read", "operator.write"]),
    });
    const page = await createRenderedPage(
      createContext(connection.gateway, sessions),
      sessionsResult([target], 1),
    );
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    await page.deleteSessionFromMenu(target);
    expect(sessions.deleteMany).not.toHaveBeenCalled();
    expect(page.error).toBe("This action requires operator.admin access.");
  });

  it("aborts delete-all when enumeration fails", async () => {
    const sessions = createSessions();
    sessions.state.error = "list failed";
    const page = await mount(sessions, [archived("agent:main:old")]);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    await page.deleteAllArchived();
    expect(showConfirmDialog).not.toHaveBeenCalled();
    expect(sessions.deleteMany).not.toHaveBeenCalled();
    expect(page.error).toBe("list failed");
  });

  it("enumerates beyond a deep link and recovers moved rows without double deletion", async () => {
    const keys = ["agent:main:first", "agent:writer:repeated", "agent:writer:moved"];
    const listed = (indices: number[], more = false) => ({
      ...sessionsResult(
        indices.map((index) => archived(keys[index]!)),
        1,
      ),
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
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
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

  it("refuses partial deletion when later pages omit the authoritative total", async () => {
    const target = archived("agent:main:only-visible");
    const list = vi.fn<SessionCapability["list"]>(async (options) => ({
      ...sessionsResult([target], 1),
      ...(options?.offset ? {} : { totalCount: 2 }),
      hasMore: !options?.offset,
      nextOffset: options?.offset ? null : 1,
    }));
    const sessions = createSessions({ list });
    const page = await mount(sessions, [target]);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    await page.deleteAllArchived();
    expect(showConfirmDialog).not.toHaveBeenCalled();
    expect(sessions.deleteMany).not.toHaveBeenCalled();
    expect(page.error).toContain("archived session enumeration was incomplete");
  });
});
