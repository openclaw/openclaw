import { expect, it } from "vitest";
import { writeTarArchiveWithRetry } from "./backup-tar-retry.js";

const cookies = String.raw`C:\state\browser\work\user-data\Default\Network\Cookies`;
const stop =
  'If the OpenClaw-managed browser profile "work" is running, stop it with `openclaw browser --browser-profile work stop`';

it.each([
  ["EBUSY", cookies, `is in use by another process (EBUSY). ${stop}`],
  ["EPERM", cookies, `could not be read (EPERM). Check that this user can read it. ${stop}`],
  ["EBUSY", "/state/agents/main/notes.db", "in use by another process (EBUSY). Close that process"],
  [
    "EACCES",
    "/state/agents/main/notes.db",
    "could not be read (EACCES). Check that this user can read it.",
  ],
  ["ENOENT", cookies, "after 1 attempt)"],
])("names the recovery step when archiving reads a %s source", async (code, path, hint) => {
  const failure = writeTarArchiveWithRetry({
    tempArchivePath: "unused.tar.gz",
    runTar: async () => {
      throw Object.assign(new Error(code), { code, path });
    },
  });
  await expect(failure).rejects.toThrow(hint);
  if (code === "EACCES" || code === "ENOENT") {
    await expect(failure).rejects.not.toThrow("another process");
  }
});
