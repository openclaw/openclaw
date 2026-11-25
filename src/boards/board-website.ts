import { z } from "zod";
import { BoardValidationError } from "./board-layout.js";

export const BOARD_WEBSITE_WIDGET_KIND = "session:website";
export const BOARD_WEBSITE_GUIDANCE =
  'Website props: {url:"https://..."}. Opens the live website in an isolated browser frame without Gateway tools or credentials. Use a public HTTPS URL without embedded credentials; the website must allow embedding. Some sign-in flows and browser cookie policies require opening the website separately. Use size:"full", then action:"set_presentation" with presentation:"expanded" for a full-task website.';

const websiteSchema = z.strictObject({
  // Bound the submitted URL before normalization can discard path segments.
  url: z
    .string()
    .max(2_048)
    .pipe(z.url({ protocol: /^https$/, normalize: true }).max(2_048)),
});

type BoardWebsite = z.infer<typeof websiteSchema>;

export function parseBoardWebsite(value: unknown): BoardWebsite {
  const result = websiteSchema.safeParse(value);
  if (!result.success) {
    throw new BoardValidationError(
      "invalid_operation",
      "Website props must contain only a valid HTTPS url of at most 2048 characters",
    );
  }
  const url = new URL(result.data.url);
  if (url.username || url.password) {
    throw new BoardValidationError(
      "invalid_operation",
      "Website URLs must not contain embedded credentials",
    );
  }
  return result.data;
}
