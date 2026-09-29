import { describe, expect, it } from "vitest";
import { buildPrivateWindowsSddl } from "./windows-private-directory-sddl.js";

// The Win32 side (reading the token and applying the descriptor) runs only on
// Windows and is covered by sqlite-private-directory.windows.test.ts; these
// cases pin the descriptor itself, so they run on every OS.
const userSid = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const appContainerSid = "S-1-15-2-1-2-3-4-5-6-7";

describe("buildPrivateWindowsSddl", () => {
  it("keeps the user, SYSTEM and Administrators DACL outside an AppContainer", () => {
    expect(buildPrivateWindowsSddl({ userSid, appContainerSid: null, inherit: true })).toBe(
      `O:${userSid}D:P(A;OICI;FA;;;${userSid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`,
    );
    expect(buildPrivateWindowsSddl({ userSid, appContainerSid: null, inherit: false })).toBe(
      `O:${userSid}D:P(A;;FA;;;${userSid})(A;;FA;;;SY)(A;;FA;;;BA)`,
    );
  });

  it("grants the token's own AppContainer SID inside an AppContainer", () => {
    expect(buildPrivateWindowsSddl({ userSid, appContainerSid, inherit: true })).toBe(
      `O:${userSid}D:P(A;OICI;FA;;;${userSid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${appContainerSid})`,
    );
    expect(buildPrivateWindowsSddl({ userSid, appContainerSid, inherit: false })).toBe(
      `O:${userSid}D:P(A;;FA;;;${userSid})(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${appContainerSid})`,
    );
  });
});
