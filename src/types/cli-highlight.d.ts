declare module "cli-highlight" {
  export type HighlightOptions = {
    language?: string;
    theme?: unknown;
    ignoreIllegals?: boolean;
  };

  export function highlight(code: string, options?: HighlightOptions): string;
  export function supportsLanguage(language: string): boolean;
}
