import { Buffer } from "node:buffer";
import type { UserProfile } from "../../../packages/gateway-protocol/src/schema/users.js";
import { encodePngRgb } from "../../../src/media/png-encode.js";
import type { AgentsListResult } from "../api/types.ts";
import type { ControlUiMockPresenceUser } from "./control-ui-mock-presence.ts";
import type { ControlUiSessionFixture } from "./control-ui-session-fixtures.ts";
import { TEAM_SCALE_AVATAR_ASSET } from "./control-ui-team-scale-people.ts";
import { TEST_LINK_READER } from "./link-reader.ts";

export type TeamScaleFixtureAsset = {
  body: string | Buffer;
  contentType: string;
  status?: number;
  delayMs?: number;
  headers?: Record<string, string>;
};
const LATE_ROW_SESSION_KEY = "agent:main:synthetic-late-row-reference";
const LATE_ROW_PR_URL = "https://github.com/example/cold-load-fixture/pull/42";
const LATE_ROW_ARTIFACT_ID = "synthetic-late-row-thumbnail";
const LATE_ROW_DOWNLOAD_PATH = "/api/artifacts/download/fixture-client/fixture-thumbnail";

function createLateRowThumbnail(seed: number): Buffer {
  // Repeated 2×4 texture cells keep real decode work below the 96 KiB rendition ceiling.
  const width = 480;
  const height = 240;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let noise = Math.imul((x >> 1) + Math.floor(y / 4) * 240 + seed, 0x45d9f3b);
      noise = Math.imul(noise ^ (noise >>> 16), 0x45d9f3b);
      noise ^= noise >>> 16;
      const offset = (y * width + x) * 3;
      pixels[offset] = noise & 255;
      pixels[offset + 1] = (noise >>> 8) & 255;
      pixels[offset + 2] = (noise >>> 16) & 255;
    }
  }
  return encodePngRgb(pixels, width, height);
}

export function createTeamScaleRowDisplayFixture({
  options,
  now,
  agents,
  session,
  transcriptSender,
  transcriptProfile,
  liveRunId,
}: {
  options: {
    lateRowFacts?: boolean;
    rowFacts?: boolean;
    transcriptAvatars?: boolean;
    liveRun?: boolean;
  };
  now: number;
  agents: AgentsListResult;
  session: ControlUiSessionFixture;
  transcriptSender: ControlUiMockPresenceUser;
  transcriptProfile: UserProfile;
  liveRunId: string;
}) {
  const assets = new Map<string, TeamScaleFixtureAsset>();
  if (options.transcriptAvatars) {
    transcriptSender.avatarUrl = `/api/users/${transcriptSender.id}/avatar?v=${now}`;
    transcriptProfile.hasAvatar = true;
    transcriptProfile.avatarMime = "image/png";
    assets.set(`/api/users/${transcriptSender.id}/avatar`, {
      ...TEAM_SCALE_AVATAR_ASSET,
      headers: { "Cache-Control": "private, max-age=31536000, immutable" },
    });
  }
  if (options.liveRun) {
    Object.assign(session, { hasActiveRun: true, status: "running", activeRunIds: [liveRunId] });
  } else if (options.rowFacts) {
    Object.assign(session, {
      status: "failed",
      lastRunId: "synthetic-row-facts-run",
      lastRunError: "Synthetic verification failed; retry the check.",
      runtimeMs: 180_000,
      contextTokens: 200_000,
    });
  }
  if (!options.lateRowFacts) {
    return { assets, lateRows: undefined };
  }
  for (const agent of agents.agents) {
    const path = `/avatar/${agent.id}`;
    agent.identity = { ...agent.identity, avatarUrl: `${path}?v=${now}` };
    assets.set(path, {
      ...TEAM_SCALE_AVATAR_ASSET,
      headers: { "Cache-Control": "private, max-age=31536000, immutable" },
    });
  }
  const cacheableImageSource = "media://inbound/synthetic-l245-cacheable.png";
  assets.set(LATE_ROW_DOWNLOAD_PATH, {
    contentType: "image/png",
    body: createLateRowThumbnail(245),
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": 'attachment; filename="synthetic-ticketed-thumbnail.png"',
    },
  });
  assets.set("/__openclaw__/assistant-media", {
    contentType: "image/png",
    body: createLateRowThumbnail(246),
    headers: { "Cache-Control": "private, no-cache" },
  });
  Object.assign(session, {
    archived: true,
    archivedAt: now - 1_000,
    archivedBy: { type: "human", id: "synthetic-maintainer", label: "Fixture maintainer" },
  });
  return {
    assets,
    lateRows: {
      history: {
        sessionKey: LATE_ROW_SESSION_KEY,
        prUrl: LATE_ROW_PR_URL,
        artifactId: LATE_ROW_ARTIFACT_ID,
        cacheableImageSource,
      },
      linkReaders: [TEST_LINK_READER],
      featureMethods: [
        "artifacts.download",
        "controlUi.sessionPreview",
        "forge.preview",
        "forge.detail",
      ],
      methodResponses: {
        "controlUi.sessionPreview": {
          cases: [
            {
              match: { sessionKey: LATE_ROW_SESSION_KEY },
              response: {
                status: "ok",
                sessionKey: LATE_ROW_SESSION_KEY,
                agentId: "main",
                title: "Synthetic linked research",
              },
            },
          ],
        },
        "forge.preview": {
          url: LATE_ROW_PR_URL,
          title: "Synthetic thumbnail restoration",
          badge: { label: "Open", tone: "positive" },
        },
        "artifacts.download": {
          cases: [
            {
              match: { artifactId: LATE_ROW_ARTIFACT_ID },
              response: {
                artifact: {
                  id: LATE_ROW_ARTIFACT_ID,
                  title: "Synthetic ticketed thumbnail",
                  type: "image",
                  mimeType: "image/png",
                  download: { mode: "url" },
                },
                url: LATE_ROW_DOWNLOAD_PATH,
                expiresAt: new Date(now + 20 * 60_000).toISOString(),
              },
            },
          ],
        },
      },
      facts: {
        sessionTitle: "Synthetic linked research",
        prUrl: LATE_ROW_PR_URL,
        artifactId: LATE_ROW_ARTIFACT_ID,
        cacheableImageSource,
        metadata: {
          available: true,
          mediaTicket: "synthetic-l245-inbound-ticket",
          mediaTicketExpiresAt: new Date(now + 20 * 60_000).toISOString(),
        },
      },
    },
  };
}
