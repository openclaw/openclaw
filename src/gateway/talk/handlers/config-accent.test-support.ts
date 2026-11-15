export const talkConfigAccentCases = [
  {
    name: "prefers the authenticated profile accent over gateway appearance defaults",
    profileId: "profile-1",
    profileAccent: "#A1B2C3",
    expectedAccent: "#a1b2c3",
  },
  {
    name: "omits a hex-only Talk accent when the profile selects theme defaults",
    profileId: "profile-1",
    profileAccent: "theme",
    expectedAccent: undefined,
  },
  {
    name: "ignores malformed authenticated profile accents",
    profileId: "profile-1",
    profileAccent: "not-a-color",
    expectedAccent: "#52c99a",
  },
  {
    name: "keeps profile-less callers on their existing gateway accent path",
    expectedAccent: "#52c99a",
  },
];
