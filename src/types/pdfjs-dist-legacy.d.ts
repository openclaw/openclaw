declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export type TextItem = {
    str: string;
  };

  export type TextMarkedContent = {
    type?: string;
  };

  export type TextContent = {
    items: Array<TextItem | TextMarkedContent>;
  };

  export type Viewport = {
    width: number;
    height: number;
  };

  export type PDFPageProxy = {
    getTextContent(): Promise<TextContent>;
    getViewport(params: { scale: number }): Viewport;
    render(params: { canvas: unknown; viewport: Viewport }): { promise: Promise<void> };
  };

  export type PDFDocumentProxy = {
    numPages: number;
    getPage(pageNumber: number): Promise<PDFPageProxy>;
  };

  export function getDocument(params: { data: Uint8Array; disableWorker?: boolean }): {
    promise: Promise<PDFDocumentProxy>;
  };
}
