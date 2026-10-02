/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import type { SessionDeleteTarget } from "../../lib/sessions/session-capability.ts";
import { createContext, createGateway, createRenderedPage } from "./sessions-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
});

describe("session selection across roster refresh", () => {
  it.each([
    "replaced",
    "replacement without IDs",
    "replacement without IDs during confirmation",
    "removed",
    "archived",
    "unchanged",
  ] as const)(
    "deletes only still-selected session identities after a row is %s",
    async (change) => {
      const missingIds = change.startsWith("replacement without IDs");
      const duringConfirmation = change === "replacement without IDs during confirmation";
      const confirmation = createDeferred<boolean>();
      const rows: GatewaySessionRow[] = Array.from({ length: 27 }, (_, index) => ({
        key: `agent:main:selection-${index}`,
        sessionId: index === 0 && missingIds ? undefined : `selected-generation-${index}`,
        kind: "direct",
        updatedAt: 100 - index,
      }));
      const original = rows[0]!;
      const stable = rows[1]!;
      let serverRows = rows;
      let revision = 0;
      const deletedStable = createDeferred();
      const deletedTargets: SessionDeleteTarget[] = [];
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        if (method === "sessions.list") {
          return sessionsResult(
            serverRows.filter((row) => !row.archived),
            ++revision,
          );
        }
        if (method === "sessions.delete") {
          const target = params as SessionDeleteTarget;
          deletedTargets.push(target);
          serverRows = serverRows.filter((row) => row.key !== target.key);
          if (target.key === stable.key) {
            deletedStable.resolve();
          }
          return { deleted: true };
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const { gateway } = createGateway({ request } as unknown as GatewayBrowserClient);
      const sessions = createTestSessionCapability(gateway);
      const subscribe = vi.spyOn(sessions, "subscribeList");
      const deletion = vi.spyOn(sessions, "deleteMany");
      const page = await createRenderedPage(
        createContext(gateway, sessions),
        sessionsResult(rows, revision),
      );
      const button = (label: string) => {
        const match = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
          (entry) => entry.textContent?.trim() === label,
        );
        if (!match) {
          throw new Error(`Missing rendered button: ${label}`);
        }
        return match;
      };
      try {
        for (const row of [original, stable]) {
          const checkbox = page.querySelector<HTMLInputElement>(
            `input[aria-label="Select session: ${row.key}"]`,
          );
          expect(checkbox).not.toBeNull();
          checkbox!.click();
          await page.updateComplete;
        }
        expect(page.querySelector(".data-table-bulk-bar")?.textContent).toContain("2 selected");
        button("Next").click();
        await page.updateComplete;
        expect(
          page.querySelector(`input[aria-label="Select session: ${original.key}"]`),
        ).toBeNull();
        expect(page.querySelector(".data-table-bulk-bar")?.textContent).toContain("2 selected");

        vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
        if (duringConfirmation) {
          button("Delete").click();
          expect(showConfirmDialog).toHaveBeenCalledOnce();
        }
        if (change === "removed") {
          serverRows = rows.slice(1);
        } else if (change === "replaced" || missingIds) {
          serverRows = [
            {
              ...original,
              label: "Replacement session",
              sessionId: missingIds ? undefined : "replacement-generation",
            },
            ...rows.slice(1),
          ];
        } else if (change === "archived") {
          serverRows = [{ ...original, archived: true }, ...rows.slice(1)];
        }
        await sessions.refreshList({ ...subscribe.mock.calls[0]![0], force: true });
        await page.updateComplete;
        if (!duringConfirmation) {
          button("Delete").click();
        }
        confirmation.resolve(true);
        await deletedStable.promise;
        const outcome = await deletion.mock.results[0]!.value;
        const expectedRows = change === "unchanged" ? [original, stable] : [stable];
        expect(outcome.errors).toEqual([]);
        expect(outcome.deleted).toEqual(expectedRows.map((row) => row.key));
        expect(serverRows.some((row) => row.key === stable.key)).toBe(false);
        if (change === "replaced" || missingIds) {
          expect(serverRows.find((row) => row.key === original.key)?.label).toBe(
            "Replacement session",
          );
        }

        expect(
          deletedTargets.map(({ key, expectedSessionId }) => ({ key, expectedSessionId })),
        ).toEqual(
          expectedRows.map((row) => ({
            key: row.key,
            expectedSessionId: row.sessionId,
          })),
        );
      } finally {
        page.remove();
        sessions.dispose();
      }
    },
  );
});
