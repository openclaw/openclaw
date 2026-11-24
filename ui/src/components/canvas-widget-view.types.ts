export type CanvasWidgetViewProps = {
  docId: string;
  sessionKey: string;
  messageTimestamp?: number;
  title: string;
  preferredHeight?: number;
  onHeightChange?: (height: number | null, settled?: boolean) => number | undefined;
  connectionGeneration: number;
  presentationActive: boolean;
  allowScripts: boolean;
};
