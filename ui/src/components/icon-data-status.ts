// Startup error views need these paths without the workspace icon catalog.
export const statusIconPaths = {
  x: ["M18 6 6 18", "m6 6 12 12"],
  refresh: ["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8M21 3v5h-5"],
  alertTriangle: [
    "m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
    "M12 9v4",
    "M12 17h.01",
  ],
} as const;
