declare module "dompurify" {
  type SanitizeOptions = {
    ALLOWED_TAGS?: string[];
    ALLOWED_ATTR?: string[];
    ADD_DATA_URI_TAGS?: string[];
  };

  const DOMPurify: {
    sanitize(html: string, config?: SanitizeOptions): string;
    addHook(entryPoint: string, hookFunction: (node: Element) => void): void;
    removeHook(entryPoint: string): void;
  };

  export default DOMPurify;
}
