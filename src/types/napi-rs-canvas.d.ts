declare module "@napi-rs/canvas" {
  export type Canvas = {
    toBuffer(type?: string): Buffer;
  };

  export function createCanvas(width: number, height: number): Canvas;
}
