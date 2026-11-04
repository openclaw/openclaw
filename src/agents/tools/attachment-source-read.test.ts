import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  profile: "A",
  session: "session-A",
  active: true,
  root: "",
  read: vi.fn(),
  dispatch: vi.fn(),
  accepted: new Map<string, string[]>(),
  execution: new Map<string, string[]>(),
}));
vi.mock("./gateway-caller-context.js", () => ({
  getGatewayToolCallerIdentity: () => ({
    agentId: "main",
    sessionKey: state.session,
    gatewayContextResolver: () => ({ getRuntimeConfig: () => ({}) }),
    operatorAuthority: {
      profileId: "original-admin",
      scopes: ["operator.admin"],
      assertCurrent() {},
    },
    assertToolAllowed() {},
  }),
  resolveGatewayToolOperatorSelection: () => ({
    operatorAuthority: {
      profileId: state.profile,
      scopes: ["operator.sessions.write"],
      assertCurrent: () => {
        if (!state.active) {
          throw new Error("source revoked");
        }
      },
    },
  }),
  captureGatewayToolCallerAssertion: () => () => {
    if (!state.active) {
      throw new Error("source revoked");
    }
  },
}));
vi.mock("../../gateway/managed-image-session-read.js", () => ({
  withManagedImageSessionRead: async (
    params: { sessionKey: string; assertCurrent: () => void },
    consume: (scope: { sessionKey: string }, assertCurrent: () => void) => Promise<unknown>,
  ) => {
    params.assertCurrent();
    return await consume({ sessionKey: params.sessionKey }, params.assertCurrent);
  },
}));
vi.mock("../../gateway/session-transcript-readers.js", () => ({
  readSessionMessagesWithSourceAsync: vi.fn(),
}));
vi.mock("../../gateway/session-transcript-source-pages.js", () => ({
  async *iterateSessionTranscriptSourcePages(_read: unknown, scope: { sessionKey: string }) {
    yield {
      messages: [
        ...(state.accepted.get(scope.sessionKey) ?? []).map((file) => ({
          role: "user",
          __openclaw: { media: [{ path: file, kind: "file" }] },
        })),
        ...(state.execution.get(scope.sessionKey) ?? []).map((file) => ({
          role: "toolResult",
          toolName: "file_fetch",
          details: { media: { mediaUrls: [file] } },
        })),
      ],
    };
  },
}));
vi.mock("../../media/store.js", () => ({ getMediaDir: () => state.root }));

import { withGatewayToolAttachmentRead } from "./attachment-source-read.js";
beforeEach(async () => {
  state.root = path.join(
    process.cwd(),
    ".openclaw/tmp/guest-relay-proof/source-ownership-fixtures",
  );
  await fs.mkdir(state.root, { recursive: true });
  for (const principal of ["A", "B"]) {
    const file = path.join(state.root, principal + ".bin");
    await fs.writeFile(file, Buffer.from([0, 255, principal.charCodeAt(0)]));
    state.accepted.set("session-" + principal, [file]);
  }
  state.profile = "A";
  state.session = "session-A";
  state.active = true;
  state.execution.clear();
  state.read.mockReset();
  state.dispatch.mockReset();
});
afterEach(async () => {
  if (state.root) {
    await fs.rm(state.root, { recursive: true, force: true });
  }
});
const transfer = (file: string) =>
  withGatewayToolAttachmentRead([file], async (assertCurrent) => {
    assertCurrent();
    state.read();
    const bytes = await fs.readFile(file);
    assertCurrent();
    state.dispatch(bytes);
    return bytes;
  });
it("allows each selected principal's accepted real attachment bytes", async () => {
  expect(await transfer(path.join(state.root, "A.bin"))).toEqual(Buffer.from([0, 255, 65]));
  state.profile = "B";
  state.session = "session-B";
  expect(await transfer(path.join(state.root, "B.bin"))).toEqual(Buffer.from([0, 255, 66]));
});
it("rejects a known foreign inbound file before byte read or node dispatch", async () => {
  await expect(transfer(path.join(state.root, "B.bin"))).rejects.toThrow(
    "not an accepted attachment",
  );
  expect(state.read).not.toHaveBeenCalled();
  expect(state.dispatch).not.toHaveBeenCalled();
});
it("does not borrow the original admin when a guest participant is selected", async () => {
  await expect(transfer(path.join(state.root, "B.bin"))).rejects.toThrow(
    "not an accepted attachment",
  );
  expect(state.read).not.toHaveBeenCalled();
});
it("retains live source authority through the transfer callback", async () => {
  await expect(
    withGatewayToolAttachmentRead([path.join(state.root, "A.bin")], async (assertCurrent) => {
      state.active = false;
      assertCurrent();
      state.dispatch();
    }),
  ).rejects.toThrow("source revoked");
  expect(state.dispatch).not.toHaveBeenCalled();
});

it("authorizes canonical inbound URI facts without accepting a foreign identifier", async () => {
  await fs.mkdir(path.join(state.root, "inbound"), { recursive: true });
  const file = path.join(state.root, "inbound", "own.bin");
  await fs.writeFile(file, Buffer.from([0, 255, 128]));
  state.accepted.set("session-A", ["media://inbound/own.bin"]);
  expect(await transfer(file)).toEqual(Buffer.from([0, 255, 128]));
});
it("authorizes only execution outputs referenced by the current canonical conversation", async () => {
  state.accepted.set("session-A", []);
  state.execution.set("session-A", [path.join(state.root, "A.bin")]);
  expect(
    await withGatewayToolAttachmentRead(
      [path.join(state.root, "A.bin")],
      async (assertCurrent) => {
        assertCurrent();
        return await fs.readFile(path.join(state.root, "A.bin"));
      },
      "file_write",
    ),
  ).toEqual(Buffer.from([0, 255, 65]));
  await expect(transfer(path.join(state.root, "B.bin"))).rejects.toThrow(
    "not an accepted attachment",
  );
});
