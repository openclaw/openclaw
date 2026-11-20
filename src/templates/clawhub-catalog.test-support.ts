export const packageName = "@openclaw/research-briefing";
export const personalPackageName = "@alice/research-briefing";
export const version = "1.0.0";
export const officialPackage = (name = packageName) => ({
  name,
  displayName: "Research Briefing",
  family: "template",
  channel: "official",
  isOfficial: true,
  ownerHandle: "openclaw",
  ownerOfficial: true,
  updatedAt: 2,
  latestVersion: version,
});

export const communityPackage = () => ({
  ...officialPackage(personalPackageName),
  channel: "community",
  isOfficial: false,
  ownerHandle: "alice",
  ownerOfficial: false,
});
