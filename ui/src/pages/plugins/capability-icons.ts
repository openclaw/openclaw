// Ordered, route-local artwork describes user capabilities, not runtime plumbing.
export const pluginCapabilityPaths = {
  speechProviders: "M3 5h8M7 5v10M4 15h6M13 10h3l4-4v14l-4-4h-3Z M22 10v6",
  realtimeTranscriptionProviders:
    "M7 2H7A3 3 0 0 1 10 5V10A3 3 0 0 1 7 13H7A3 3 0 0 1 4 10V5A3 3 0 0 1 7 2Z M1 10a6 6 0 0 0 12 0M7 16v5M4 21h6M16 6h6M16 11h4M16 16h6",
  realtimeVoiceProviders:
    "M2 10v4M6 7v10M10 10v4M14 7v10M18 10v4M22 7v10M4 3h13m-2-2 2 2-2 2M20 21H7m2-2-2 2 2 2",
  mediaUnderstandingProviders:
    "M8 3H4a1 1 0 0 0-1 1v4M16 3h4a1 1 0 0 1 1 1v4M3 16v4a1 1 0 0 0 1 1h4M21 16v4a1 1 0 0 1-1 1h-4M4 12s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z M14 12A2 2 0 1 1 10 12A2 2 0 1 1 14 12Z",
  imageGenerationProviders:
    "M12 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-8M3 17l5-5 4 4 3-3 6 6M18 2l1 3 3 1-3 1-1 3-1-3-3-1 3-1Z M8.5 7.5A1 1 0 1 1 6.5 7.5A1 1 0 1 1 8.5 7.5Z",
  videoGenerationProviders:
    "M4 3H20A2 2 0 0 1 22 5V19A2 2 0 0 1 20 21H4A2 2 0 0 1 2 19V5A2 2 0 0 1 4 3Z M2 7h20M2 17h20M7 3v4M12 3v4M17 3v4M7 17v4M12 17v4M17 17v4M10 10l5 2-5 2Z",
  musicGenerationProviders:
    "M9 18V5l12-3v13M9 9l12-3M3 2v4M1 4h4 M9 18A3.5 3 0 1 1 2 18A3.5 3 0 1 1 9 18Z M21 15A3.5 3 0 1 1 14 15A3.5 3 0 1 1 21 15Z",
  embeddingProviders:
    "M7 5h10M6 7l5 9M18 7l-5 9 M8 5A3 3 0 1 1 2 5A3 3 0 1 1 8 5Z M22 5A3 3 0 1 1 16 5A3 3 0 1 1 22 5Z M15 19A3 3 0 1 1 9 19A3 3 0 1 1 15 19Z M9 11h6",
  webSearchProviders:
    "M15 3a8 8 0 1 0-5 16M2 11h13M10 3a17 17 0 0 0 0 16M10 3a17 17 0 0 1 2 10 M20 16A4 4 0 1 1 12 16A4 4 0 1 1 20 16Z m19 19 3 3",
  webFetchProviders:
    "M4 3H20A2 2 0 0 1 22 5V19A2 2 0 0 1 20 21H4A2 2 0 0 1 2 19V5A2 2 0 0 1 4 3Z M2 8h20M6 5.5h.01 M12 11v7m-3-3 3 3 3-3",
  webContentExtractors:
    "M11 21H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4M2 8h20M6 5.5h.01M6 12h6M6 16h3M14 16h9m-3-3 3 3-3 3",
  documentExtractors:
    "M11 22H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9l5 5v4M13 2v6h6M7 12h4M7 16h3M14 17h9m-3-3 3 3-3 3",
  transcriptSourceProviders:
    "M7 2H19A2 2 0 0 1 21 4V17A2 2 0 0 1 19 19H7A2 2 0 0 1 5 17V4A2 2 0 0 1 7 2Z M2 6v14a2 2 0 0 0 2 2h13M9 7h3M9 11h8M9 15h6",
  migrationProviders:
    "M4 9V4a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v5M12 1v13m-4-4 4 4 4-4M3 12l-1 8a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1l-1-8M2 16h5l2 3h6l2-3h5",
} as const;
