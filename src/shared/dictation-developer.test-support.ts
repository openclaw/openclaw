/** Independent exact-byte conformance data, shared by tests and the measured corpus. */
export const developerConformanceCases: ReadonlyArray<{
  source: string;
  expected: string;
  /** Absent means the same expected bytes apply to every advertised profile. */
  profileId?: string;
}> = [
  { source: "start code open paren x comma y close paren end code", expected: "(x, y)" },
  { source: "snake case customer account ID end identifier", expected: "customer_account_id" },
  { source: "camel case get user by ID end identifier", expected: "getUserById" },
  { source: "pascal case get user by ID end identifier", expected: "GetUserById" },
  { source: "kebab case customer account ID end identifier", expected: "customer-account-id" },
  { source: "spell capital A lower b digit zero end spell", expected: "Ab0" },
  { source: "spell A b 0 end spell", expected: "Ab0" },
  { source: "spell digit zero digit zero digit seven end spell", expected: "007" },
  { source: "symbol literal backslash n end symbol", expected: "\\n" },
  { source: "symbol new line end symbol", expected: "\n" },
  { source: "start code space tab new line space end code", expected: " \t\n " },
  { source: "start code open bracket 01 comma 02 close bracket end code", expected: "[01, 02]" },
  { source: "start code customer underscore ID end code", expected: "customer_ID" },
  { source: "literal words open paren  new line end literal", expected: "open paren  new line" },
  { source: "start code literal words end code end literal end code", expected: "end code" },
  { source: 'start code "open paren end code" end code', expected: '"open paren end code"' },
  {
    source: "start code /srv/Project-X/v01.2/file.ts end code",
    expected: "/srv/Project-X/v01.2/file.ts",
  },
  {
    source: "start code C:\\Users\\ALICE\\001\\file.py end code",
    expected: "C:\\Users\\ALICE\\001\\file.py",
  },
  { source: String.raw`start code /a\d+\s?/gi end code`, expected: String.raw`/a\d+\s?/gi` },
  { source: 'start code "a\\\"b" end code', expected: '"a\\\"b"' },
  {
    source: "start code AbCdEf0123456789 2026-11-26 v01.002 end code",
    expected: "AbCdEf0123456789 2026-11-26 v01.002",
  },
  { source: "start code e\u0301  \t漢字 end code", expected: "e\u0301  \t漢字" },
  {
    source: "start code literal words // say open paren end literal end code",
    expected: "// say open paren",
  },
  {
    source: "start code /a open paren b close paren c/ end code",
    expected: "/a open paren b close paren c/",
  },
  {
    source: String.raw`start code /[\/] open paren x/gi end code`,
    expected: String.raw`/[\/] open paren x/gi`,
  },
  {
    source: "start code x / y plus z / q end code",
    expected: "x / y plus z / q",
    profileId: "en-us-typescript",
  },
  {
    source: "start code x space slash space y plus z space slash space q end code",
    expected: "x / y + z / q",
    profileId: "en-us-typescript",
  },
  { source: "start code /[a/b] open paren/ end code", expected: "/[a/b] open paren/" },
  {
    source: "START CODE /a open paren b close paren c/ END CODE",
    expected: "/a open paren b close paren c/",
  },
  {
    source: "start  code /a open paren b close paren c/ end  code",
    expected: "/a open paren b close paren c/",
  },
  {
    source: "start code /a open paren b close paren c/.test(x) end code",
    expected: "/a open paren b close paren c/.test(x)",
    profileId: "en-us-typescript",
  },
  {
    source: "start code const pattern equal sign /a open paren b close paren c/ end code",
    expected: "const pattern = /a open paren b close paren c/",
    profileId: "en-us-typescript",
  },
  {
    profileId: "en-us-json",
    source:
      "start code open brace quote ID quote colon 7 comma quote v quote colon quote 01.2 quote close brace end code",
    expected: '{"ID": 7, "v": "01.2"}',
  },
  {
    profileId: "en-us-typescript",
    source: "start code const camel case user ID end identifier equal sign 007 semicolon end code",
    expected: "const userId = 007;",
  },
  {
    profileId: "en-us-python",
    source:
      "start code def snake case get ID end identifier open paren x close paren colon new line indent return x end code",
    expected: "def get_id(x):\n    return x",
  },
  {
    profileId: "en-us-python",
    source: "start code r'hello open paren end code world' end code",
    expected: "r'hello open paren end code world'",
  },
  {
    profileId: "en-us-python",
    source: "start code fr'''hello don't open paren end code world''' end code",
    expected: "fr'''hello don't open paren end code world'''",
  },
  {
    profileId: "en-us-python",
    source: "start code x=r'hello open paren end code world' end code",
    expected: "x=r'hello open paren end code world'",
  },
  {
    profileId: "en-us-plain-code",
    source: "start code x not equal y end code",
    expected: "x != y",
  },
];
