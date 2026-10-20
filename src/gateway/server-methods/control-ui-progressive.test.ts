import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.js";
import { createControlUiRequestOptions } from "./control-ui-request.test-support.js";
import { controlUiHandlers } from "./control-ui.js";
import type { RespondFn } from "./types.js";

const requestOptions = createControlUiRequestOptions(() => ({ agents: { entries: { main: {} } } }));

describe("progressive controlUi.githubDetail", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("forwards overview requests through the identity adapter without reading optional endpoints", async () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      gateway: { controlUi: { github: { token: "progressive-service-token" } } },
    };
    setRuntimeConfigSnapshot(cfg);
    const head = "a".repeat(40);
    const optional = vi.fn();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path.endsWith("/pulls/7")) {
        return Response.json({
          title: "Early body",
          body: "Available before CI",
          state: "open",
          created_at: "2026-10-01T00:00:00Z",
          updated_at: "2026-10-02T00:00:00Z",
          comments: 1,
          review_comments: 1,
          changed_files: 1,
          head: { sha: head },
        });
      }
      if (path.endsWith("/progressive-adapter")) {
        return Response.json({ id: 771, private: false, visibility: "public" });
      }
      optional();
      return new Response(null, { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const handler = expectDefined(controlUiHandlers["controlUi.githubDetail"], "detail handler");
    const respond = vi.fn<RespondFn>();
    await handler(
      requestOptions(
        {
          kind: "pull",
          owner: "octocat",
          repo: "progressive-adapter",
          number: 7,
          section: "overview",
        },
        respond,
        { context: { getRuntimeConfig: () => cfg } },
      ),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        title: "Early body",
        body: "Available before CI",
        revision: head,
        deferredSections: ["checks", "files", "discussion"],
        partial: false,
      }),
      undefined,
    );
    expect(optional).not.toHaveBeenCalled();
    const payload = respond.mock.calls[0]?.[1];
    expect(payload).not.toHaveProperty("checks");
    expect(payload).not.toHaveProperty("comments");
    expect(payload).not.toHaveProperty("files");
  });

  it.each(["invalid", null, 1])(
    "rejects invalid detail section %j before upstream access",
    async (section) => {
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);
      const respond = vi.fn<RespondFn>();
      await expectDefined(
        controlUiHandlers["controlUi.githubDetail"],
        "detail handler",
      )(
        requestOptions(
          { kind: "issue", owner: "octocat", repo: "repo", number: 1, section },
          respond,
        ),
      );
      expect(respond).toHaveBeenCalledWith(false, undefined, {
        code: "INVALID_REQUEST",
        message: "invalid controlUi.githubDetail params",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
