import { expect, it } from "vitest";
import { describeLockedBackupSource } from "./backup-locked-source.js";
import { writeTarArchiveWithRetry } from "./backup-tar-retry.js";

const lockedAt = (code: string, path: string) => Object.assign(new Error(code), { code, path });
const cookies = String.raw`C:\state\browser\work\user-data\Default\Network\Cookies`;

it.each([
  [
    lockedAt("EBUSY", cookies),
    /profile "work" has .*Cookies open \(EBUSY\).*--browser-profile work stop/,
  ],
  [lockedAt("EPERM", "/state/browser/openclaw/user-data/Default/Cookies"), /profile "openclaw"/],
  [
    lockedAt("EBUSY", "/state/agents/main/notes.db"),
    /Another process has \/state\/agents\/main\/notes\.db open/,
  ],
  [lockedAt("ENOENT", cookies), /^$/],
  [new Error("plain"), /^$/],
])("describes the recovery step for %o", (error, expected) => {
  expect(describeLockedBackupSource(error)).toMatch(expected);
});

it("names the managed browser stop step when archiving reads a locked profile file", async () => {
  await expect(
    writeTarArchiveWithRetry({
      tempArchivePath: "unused.tar.gz",
      runTar: async () => {
        throw lockedAt("EBUSY", cookies);
      },
    }),
  ).rejects.toThrow(/after 1 attempt\) The OpenClaw-managed browser profile "work"/);
});
