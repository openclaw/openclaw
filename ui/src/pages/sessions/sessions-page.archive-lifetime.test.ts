/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import * as confirmDialog from "../../components/confirm-dialog.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import {
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import { createContext, createGateway, createRenderedPage } from "./sessions-page.test-support.ts";

const archiveImport = vi.hoisted(() => {
  let release!: () => void;
  let markStarted!: () => void;
  return {
    held: new Promise<void>((resolve) => {
      release = resolve;
    }),
    started: new Promise<void>((resolve) => {
      markStarted = resolve;
    }),
    release: () => release(),
    markStarted: () => markStarted(),
  };
});

// Hold only module availability; confirmations and archive operations stay real.
vi.mock("../../components/session-organizer-archive.runtime.ts", async (importOriginal) => {
  archiveImport.markStarted();
  await archiveImport.held;
  return importOriginal();
});

async function setup() {
  const row: GatewaySessionRow = {
    key: "agent:main:archive-lifetime",
    sessionId: "archive-lifetime-session",
    kind: "direct",
    label: "Running conversation",
    sharingRole: "owner",
    hasActiveRun: true,
  };
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.list") {
      const query = params as { spawnedBy?: string } | undefined;
      return sessionsResult(query?.spawnedBy ? [] : [row], 1);
    }
    if (method === "sessions.describe") {
      return { session: row };
    }
    throw new Error(
      method === "sessions.patch" || method === "sessions.patchMany"
        ? "Retired archive must not write"
        : "Unexpected request: " + method,
    );
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const gateway = createGateway(client);
  const sessions = createTestSessionCapability(gateway.gateway);
  const page = await createRenderedPage(
    createContext(gateway.gateway, sessions),
    sessionsResult([row], 1),
  );
  const writes = () =>
    request.mock.calls.filter(
      ([method]) => method === "sessions.patch" || method === "sessions.patchMany",
    );
  return { page, row, client, gateway, sessions, writes };
}

describe("Sessions page archive confirmation lifetime", () => {
  it("does not open a confirmation when navigation retires a pending archive import", async () => {
    const modal = createModalDialogTestFixture();
    const fixture = await setup();
    const confirm = vi.spyOn(confirmDialog, "showConfirmDialog");
    try {
      const archive = modal.track(fixture.page.archiveActions.archive(fixture.row));
      const tree = modal.track(fixture.page.archiveActions.archiveTree(fixture.row));
      await archiveImport.started;
      fixture.page.remove();
      archiveImport.release();
      await vi.dynamicImportSettled();

      expect(confirm).not.toHaveBeenCalled();
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
      await Promise.all([archive, tree]);
      expect(fixture.writes()).toEqual([]);
    } finally {
      archiveImport.release();
      fixture.page.remove();
      await modal.cleanup();
      fixture.sessions.dispose();
      confirm.mockRestore();
    }
  });

  it.each([
    { action: "archive", retire: "navigate" },
    { action: "archive", retire: "reconnect" },
    { action: "archiveTree", retire: "navigate" },
    { action: "archiveTree", retire: "reconnect" },
  ] as const)(
    "closes an open $action confirmation on $retire without writing",
    async ({ action, retire }) => {
      archiveImport.release();
      const modal = createModalDialogTestFixture();
      const fixture = await setup();
      try {
        const operation = modal.track(fixture.page.archiveActions[action](fixture.row));
        await waitForConfirmDialogActions();
        expect(document.body.querySelector("openclaw-modal-dialog")).not.toBeNull();
        expect(fixture.writes()).toEqual([]);

        if (retire === "navigate") {
          fixture.page.remove();
        } else {
          fixture.gateway.emit({ phase: "reconnecting", client: null });
          fixture.gateway.emit({ phase: "connected", client: fixture.client });
        }

        expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
        await operation;
        expect(fixture.writes()).toEqual([]);
        expect(fixture.sessions.archiveVisibility(fixture.row.key)).not.toBe("pending");
      } finally {
        fixture.page.remove();
        await modal.cleanup();
        fixture.sessions.dispose();
      }
    },
  );
});
