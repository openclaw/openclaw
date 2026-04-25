export function withoutProcessVersionsBunForTest(): () => void {
  const originalVersions = process.versions;
  const versionsWithoutBun: Record<string, string> = {};
  for (const [key, value] of Object.entries(originalVersions)) {
    if (key !== "bun" && typeof value === "string") {
      versionsWithoutBun[key] = value;
    }
  }

  Object.defineProperty(process, "versions", {
    configurable: true,
    value: versionsWithoutBun,
  });

  return () => {
    Object.defineProperty(process, "versions", {
      configurable: true,
      value: originalVersions,
    });
  };
}
