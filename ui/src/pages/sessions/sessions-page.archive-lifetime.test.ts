/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  const held = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  return {
    held: held.promise,
    release: held.resolve,
    started: started.promise,
    markStarted: started.resolve,
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
    sharingRole: "owner",
    hasActiveRun: true,
  };
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.list") {
      const query = params as { spawnedBy?: string } | undefined;
      return sessionsResult(
        query?.spawnedBy === row.key
          ? [{ ...row, key: "agent:main:child", sessionId: "child-session" }]
          : query?.spawnedBy
            ? []
            : [row],
        1,
      );
    }
    if (method === "sessions.describe") {
      return { session: row };
    }
    throw new Error("Unexpected request: " + method);
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

let fixture: Awaited<ReturnType<typeof setup>>;
let modal: ReturnType<typeof createModalDialogTestFixture>;
beforeEach(async () => {
  modal = createModalDialogTestFixture();
  fixture = await setup();
});
afterEach(async () => {
  archiveImport.release();
  fixture.page.remove();
  await modal.cleanup();
  fixture.sessions.dispose();
  vi.restoreAllMocks();
});

it.each([
  [null, "navigate"],
  [false, "navigate"],
  [false, "reconnect"],
  [true, "navigate"],
  [true, "reconnect"],
] as const)("retires archive intent (descendants=%s, retired=%s)", async (descendants, retire) => {
  const importing = descendants === null;
  if (!importing) {
    archiveImport.release();
  }
  const confirm = vi.spyOn(confirmDialog, "showConfirmDialog");
  const operations = (descendants === null ? [false, true] : [descendants]).map((tree) =>
    modal.track(fixture.page.archive(fixture.row, tree)),
  );
  if (importing) {
    await archiveImport.started;
  } else {
    await waitForConfirmDialogActions();
    expect(document.body.querySelector("openclaw-modal-dialog")).not.toBeNull();
    expect(fixture.writes()).toEqual([]);
  }
  if (retire === "navigate") {
    fixture.page.remove();
  } else {
    fixture.gateway.emit({ phase: "reconnecting", client: null });
    fixture.gateway.emit({ phase: "connected", client: fixture.client });
  }
  if (importing) {
    archiveImport.release();
    await vi.dynamicImportSettled();
    expect(confirm).not.toHaveBeenCalled();
  }
  expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  await Promise.all(operations);
  expect(fixture.writes()).toEqual([]);
  if (!importing) {
    expect(fixture.sessions.archiveVisibility(fixture.row.key)).not.toBe("pending");
  }
});
