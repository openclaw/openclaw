// Fetched SQL query files stay managed documents that download with their SQL MIME type.
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import {
  disposeStoreRemoteFixtures,
  withStoreRemoteFixture,
  wrapStoreSaveRemoteMedia,
} from "../media/store-network.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  assistantMessage,
  requestManagedImage,
  useManagedImageState,
} from "./managed-image-attachments.http.test-support.js";
import { requireBlock } from "./managed-image-attachments.test-support.js";

const { createManagedOutgoingMediaBlocks } = await import("./managed-image-attachments.js");

let storeSaveSpy: MockInstance<typeof import("../media/fetch.js").saveRemoteMedia> | undefined;

beforeAll(async () => {
  // Spy after graph evaluation: importOriginal(fetch) can pull store into its mock cycle.
  const mediaFetch = await import("../media/fetch.js");
  const saveRemoteMedia = mediaFetch.saveRemoteMedia;
  storeSaveSpy = vi
    .spyOn(mediaFetch, "saveRemoteMedia")
    .mockImplementation(wrapStoreSaveRemoteMedia(saveRemoteMedia));
});

afterAll(() => {
  try {
    disposeStoreRemoteFixtures();
  } finally {
    storeSaveSpy?.mockRestore();
  }
});

describe("managed SQL document attachments", () => {
  let stateDir: string;
  useManagedImageState("managed-sql-documents-", (prepared) => {
    stateDir = prepared;
  });

  it.each([
    { pathname: "/query.sql", headerMime: "text/plain", mimeType: "text/x-sql" },
    { pathname: "/query", headerMime: "application/sql", mimeType: "application/sql" },
  ])(
    "fetches and serves SQL documents reported as $headerMime",
    async ({ pathname, headerMime, mimeType }) => {
      const body = Buffer.from("SELECT name FROM widgets;\n");
      const upstream = http.createServer((_req, res) => {
        res.setHeader("content-type", headerMime);
        res.end(body);
      });
      const origin = await listenLoopback(upstream);
      try {
        await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
          const sourceUrl = `${origin}${pathname}`;
          const blocks = await withStoreRemoteFixture({ url: sourceUrl }, () =>
            createManagedOutgoingMediaBlocks({
              sessionKey: "agent:main:main",
              items: [{ url: sourceUrl, filename: "query.sql", trustedLocal: false }],
              messageId: "msg-1",
              stateDir,
            }),
          );
          expect(blocks).toHaveLength(1);
          const attachment = (requireBlock(blocks) as { attachment?: { url?: string } }).attachment;
          expect(attachment).toMatchObject({ kind: "document", label: "query.sql", mimeType });
          const { result } = await requestManagedImage({
            stateDir,
            pathName: attachment?.url ?? "",
            authResponse: { authMethod: "token" },
            transcriptMessages: [assistantMessage(blocks)],
          });
          expect(result.statusCode).toBe(200);
          expect(result.headers["content-type"]).toBe(mimeType);
          expect(result.headers["content-disposition"]).toContain('filename="query.sql"');
          expect(result.body).toEqual(body);
        });
      } finally {
        await closeHttpServer(upstream);
      }
    },
  );
});
