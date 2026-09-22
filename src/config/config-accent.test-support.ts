export const configAccentCases = [
  ["theme default", "theme", true],
  ["lowercase hex", "#ff5c5c", true],
  ["uppercase hex", "#AbCdEf", true],
  ["missing hash", "ff5c5c", false],
  ["invalid hex", "#gggggg", false],
  ["invalid length", "#ff5c5c00", false],
] as const;
