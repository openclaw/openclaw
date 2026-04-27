// Strips invisible / formatting characters from filenames carried over
// untrusted boundaries (HTTP Content-Disposition, URL pathname). The pattern
// is built via the RegExp constructor so the source file stays plain ASCII.
//   - C0/C1 control: U+0000-U+001F, U+007F-U+009F
//   - Zero-width:    U+200B-U+200D, U+FEFF
//   - Bidi format:   U+202A-U+202E, U+2066-U+2069
const FILENAME_INVISIBLE_CONTROL_PATTERN =
  "[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200D\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]";
const FILENAME_INVISIBLE_CONTROL_RE = new RegExp(FILENAME_INVISIBLE_CONTROL_PATTERN, "g");

export function stripFilenameControlChars(value: string): string {
  return value.replace(FILENAME_INVISIBLE_CONTROL_RE, "");
}
