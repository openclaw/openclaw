declare module "marked" {
  type MarkedOptions = {
    gfm?: boolean;
    breaks?: boolean;
    renderer?: MarkedRenderer;
  };

  type MarkedRenderer = {
    html?: (token: { text: string }) => string;
  };

  export const marked: {
    setOptions(options: MarkedOptions): void;
    parse(markdown: string, options?: MarkedOptions): string;
    Renderer: new () => MarkedRenderer;
  };
}
