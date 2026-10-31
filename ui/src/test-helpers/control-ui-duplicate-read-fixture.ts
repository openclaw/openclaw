type TeamScaleAudioAttachment = {
  type: "audio";
  artifactId: string;
  url: string;
  fileName: string;
  mimeType: string;
  durationMs: number;
};

export function createTeamScaleDuplicateReadFixture(sessionKey: string, now: number) {
  const mediaId = "00000000-0000-4000-8000-000000000001";
  const mediaPath = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${mediaId}/full`;
  return {
    mediaPath,
    asset: {
      contentType: "audio/wav",
      body: "RIFF,\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x40\x1f\0\0\x40\x1f\0\0\x01\0\x08\0data\x08\0\0\0@@@@@@@@",
    },
    worktree: {
      id: "team-scale-worktree",
      branch: "fixture/duplicate-reads",
      repoRoot: "/synthetic/team-scale-project",
    },
    attachments: Array.from({ length: 6 }, (_unused, alias): TeamScaleAudioAttachment => ({
      type: "audio",
      artifactId: `artifact_managed_media_${mediaId}`,
      url: `${mediaPath}?mediaTicket=historical-${alias}`,
      fileName: `Shared recording ${alias + 1}.wav`,
      mimeType: "audio/wav",
      durationMs: 1,
    })),
    featureMethods: ["session.suggestions.list", "sessions.github.publish"],
    methodResponses: {
      "session.suggestions.list": { suggestions: [], role: "owner" },
      "artifacts.download": {
        artifact: {
          id: `artifact_managed_media_${mediaId}`,
          title: "Shared recording",
          type: "audio",
          mimeType: "audio/wav",
          download: { mode: "url" },
        },
        url: `${mediaPath}?mediaTicket=current`,
        expiresAt: new Date(now + 20 * 60_000).toISOString(),
      },
    },
  };
}
