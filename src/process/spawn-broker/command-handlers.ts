// An update can replace the installed chunks after readiness. Retain every command
// this mode can serve while its originating package still exists.
export async function captureBrokerCommandHandlers(canReadFiles: boolean) {
  const [execa, file, page] = await Promise.all([
    import("./execa-worker.js"),
    canReadFiles ? import("@openclaw/fs-safe/advanced") : undefined,
    canReadFiles ? import("../../agents/sessions/tools/read-file-page.js") : undefined,
  ]);
  return {
    startBrokerExeca: execa.startBrokerExeca,
    readers:
      file && page
        ? { readRegularFile: file.readRegularFile, captureReadFilePage: page.captureReadFilePage }
        : undefined,
  };
}
