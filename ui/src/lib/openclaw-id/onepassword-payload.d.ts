/** Encodes one recovery kit through the official package's supported JavaScript API. */
export declare function encodeOnePasswordKit(payload: {
  title: string;
  username: string;
  code: string;
  notes: string;
  url: string;
}): string | undefined;
