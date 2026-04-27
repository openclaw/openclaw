export type CanvasSurface = "assistant_message";
export type CanvasPreview = {
    kind: "canvas";
    surface: CanvasSurface;
    render: "url";
    title?: string;
    preferredHeight?: number;
    url?: string;
    viewId?: string;
    className?: string;
    style?: string;
};
export declare function extractCanvasFromText(outputText: string | undefined, _toolName?: string): CanvasPreview | undefined;
export declare function extractCanvasShortcodes(text: string | undefined): {
    text: string;
    previews: CanvasPreview[];
};
