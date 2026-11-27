// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FileReference,
  FileReferenceCapability,
  FileReferenceResult,
  SessionsFilesReferencesParams,
} from "../../../../src/shared/file-references.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { FileReferenceDestination } from "../../lib/chat/file-reference-destination.ts";
import {
  ComposerFileReferenceOwner,
  type FileReferenceSource,
} from "./composer-file-references.ts";

const owners: ComposerFileReferenceOwner[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.dispose();
  }
  vi.restoreAllMocks();
});

function fixture(options: { binding?: boolean; unknown?: boolean } = {}) {
  const capability: FileReferenceCapability = {
    schemaVersion: 1,
    namespace: "openclaw.session-file.v1",
    providerId: "session-workspace-local",
    accountId: "account",
    workspaceId: "workspace",
    rootLabel: "Synthetic workspace",
    authorizationRevision: "authorization",
    resolverRevision: "resolver",
    leaseId: "lease",
    leaseExpiresAt: Date.now() + 60000,
  };
  const { leaseId: _leaseId, ...identity } = capability;
  const reference: FileReference = {
    ...identity,
    objectId: "object-a",
    relativePath: "src/auth.ts",
    displayLabel: "auth.ts",
  };
  const response = (): FileReferenceResult => ({
    status: "matches",
    capability,
    candidates: [{ reference, match: "path" }],
    indexComplete: true,
    scannedEntries: 1,
  });
  const request = vi.fn(async (params: SessionsFilesReferencesParams): Promise<unknown> => {
    if (params.action === "capabilities") {
      return { status: "ready", capability };
    }
    if (params.action === "search") {
      return response();
    }
    if (params.action === "revalidate") {
      return { status: "validated", reference };
    }
    return { status: "released" };
  });
  const input = document.createElement("textarea");
  const source: FileReferenceSource = {
    client: {},
    connected: true,
    sessionKey: "agent:main:synthetic",
    agentId: "main",
    draft: "Before ",
    revision: 0,
    target: input,
    locale: "en-US",
    eligible: true,
    request,
  };
  const commit = vi.fn<FileReferenceDestination["commit"]>((edit) => {
    source.draft = source.draft.slice(0, edit.from) + edit.text + source.draft.slice(edit.to);
    source.revision += 1;
    owner.sync();
    return { status: options.unknown ? "outcome-unknown" : "committed" };
  });
  const destination: FileReferenceDestination = {
    schemaVersion: 1,
    namespace: "openclaw.session-file.v1",
    snapshot: () => ({
      text: source.draft,
      revision: source.revision,
      targetId: "native-editor",
      references: [],
    }),
    commit,
    clearReferences: vi.fn(),
  };
  const readSource = vi.fn(() => ({ ...source }));
  const owner = new ComposerFileReferenceOwner(readSource, async () =>
    options.binding === false ? null : destination,
  );
  owners.push(owner);
  async function dictate(
    text = "reference file src slash auth dot ts end reference",
    final = true,
    complete = true,
  ) {
    const previousValue = source.draft;
    const accepted = owner.capture();
    source.draft += text;
    source.revision += 1;
    accepted?.(
      {
        target: input,
        text,
        complete,
        from: previousValue.length,
        to: source.draft.length,
        previousValue,
        value: source.draft,
      },
      final,
    );
    await vi.waitFor(() => expect(owner.busy).toBe(false));
  }
  return { owner, source, readSource, request, reference, capability, response, commit, dictate };
}

describe("reference review ownership", () => {
  it("revokes old session consent synchronously when a new capture precedes the render effect", () => {
    const h = fixture();
    h.owner.enable(true);
    h.source.sessionKey = "agent:main:new-session";
    expect(h.owner.capture()).toBeUndefined();
    expect(h.owner.enabled).toBe(false);
    expect(h.request).not.toHaveBeenCalled();
  });
  it.each(["off", "literal", "locale", "incomplete", "truncated"])(
    "preserves baseline dictation with %s",
    async (mode) => {
      const h = fixture();
      if (mode !== "off") {
        h.owner.enable(true);
      }
      if (mode === "literal") {
        h.owner.setLiteral(true);
      }
      if (mode === "locale") {
        h.source.locale = "de-DE";
      }
      await h.dictate(undefined, mode !== "incomplete", mode !== "truncated");
      expect(h.request).not.toHaveBeenCalled();
      expect(h.source.draft).toContain("reference file");
    },
  );

  it("requires explicit selection and commits only once despite repeated confirmation", async () => {
    const h = fixture();
    h.owner.enable(true);
    await h.dictate();
    await h.owner.confirm();
    expect(h.commit).not.toHaveBeenCalled();
    h.owner.select(h.reference.objectId);
    await Promise.all([h.owner.confirm(), h.owner.confirm()]);
    expect(h.commit).toHaveBeenCalledOnce();
    expect(h.source.draft).toBe("Before @src/auth.ts");
    expect(h.owner.phase).toBe("committed");
  });

  it("rejects equal-text replacement by revision and retains the draft", async () => {
    const h = fixture();
    h.owner.enable(true);
    await h.dictate();
    h.owner.select(h.reference.objectId);
    const draft = h.source.draft;
    h.source.revision += 1;
    h.owner.sync();
    await h.owner.confirm();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.source.draft).toBe(draft);
    expect(h.owner.phase).toBe("stale");
  });

  it("retires old async reviews and releases their lease on presenter rebind", async () => {
    const h = fixture();
    h.owner.enable(true);
    await h.dictate();
    const pending = createDeferred<unknown>();
    h.request.mockImplementationOnce(() => pending.promise);
    const search = h.owner.search();
    const newRequest = vi.fn(async () => ({ status: "denied" }));
    const replacement = {
      ...h.source,
      client: {},
      target: document.createElement("textarea"),
      request: newRequest,
    };
    h.readSource.mockImplementation(() => {
      throw new Error("Disposed source must not be read");
    });
    h.owner.rebind(() => replacement);
    pending.resolve(h.response());
    await search;
    expect(h.owner.open).toBe(false);
    expect(h.owner.enabled).toBe(false);
    expect(h.request).toHaveBeenCalledWith(
      expect.objectContaining({ action: "release", leaseId: "lease" }),
    );
    expect(newRequest).not.toHaveBeenCalled();
    h.owner.enable(true);
    expect(h.owner.enabled).toBe(true);
  });

  it("does not retry or copy an uncertain editor delivery", async () => {
    const h = fixture({ unknown: true });
    h.owner.enable(true);
    await h.dictate();
    h.owner.select(h.reference.objectId);
    await h.owner.confirm();
    h.owner.setQuery("another.ts");
    await h.owner.search();
    await h.owner.confirm();
    await h.owner.copy(false);
    expect(h.commit).toHaveBeenCalledOnce();
    expect(h.owner.phase).toBe("outcome-unknown");
  });

  it("drops out-of-order search results", async () => {
    const h = fixture();
    h.owner.enable(true);
    await h.dictate();
    const older = createDeferred<unknown>();
    h.request.mockImplementationOnce(() => older.promise);
    h.owner.setQuery("old.ts");
    const oldSearch = h.owner.search();
    h.owner.setQuery("src/auth.ts");
    await h.owner.search();
    older.resolve({ ...h.response(), candidates: [] });
    await oldSearch;
    expect(h.owner.candidates.map(({ reference }) => reference.objectId)).toEqual([
      h.reference.objectId,
    ]);
  });

  it.each(["cancel", "capture", "offline", "workspace"])(
    "late search cannot reopen after %s",
    async (change) => {
      const h = fixture();
      h.owner.enable(true);
      await h.dictate();
      const pending = createDeferred<unknown>();
      h.request.mockImplementationOnce(() => pending.promise);
      const search = h.owner.search();
      if (change === "cancel") {
        h.owner.cancel();
      }
      if (change === "capture") {
        h.owner.capture();
      }
      if (change === "offline") {
        h.source.connected = false;
        h.owner.sync();
      }
      if (change === "workspace") {
        h.source.sessionKey = "agent:main:other";
        h.owner.sync();
      }
      pending.resolve(h.response());
      await search;
      expect(h.owner.open).toBe(false);
      expect(h.commit).not.toHaveBeenCalled();
    },
  );

  it("rejects revalidation for another account before delivery", async () => {
    const h = fixture();
    h.owner.enable(true);
    await h.dictate();
    h.owner.select(h.reference.objectId);
    h.request.mockImplementationOnce(async () => ({
      status: "validated",
      reference: { ...h.reference, accountId: "other" },
    }));
    await h.owner.confirm();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.owner.phase).toBe("denied");
  });

  it("keeps unsupported destinations copy-only and current-file shortcuts unavailable", async () => {
    const h = fixture({ binding: false });
    h.owner.enable(true);
    await h.dictate();
    h.owner.select(h.reference.objectId);
    await h.owner.confirm();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.owner.supportsBinding).toBe(false);
    await h.dictate("reference current file end reference");
    expect(h.owner.phase).toBe("unsupported");
  });
});
