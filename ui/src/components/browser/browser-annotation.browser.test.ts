import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { composeAnnotatedImage } from "./browser-annotation.ts";

it("composites click dots and drawn paths without altering unmarked pixels", async () => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const drawing = expectDefined(canvas.getContext("2d"), "annotation canvas");
  drawing.fillStyle = "white";
  drawing.fillRect(0, 0, 64, 64);
  const image = new Image();
  image.src = composeAnnotatedImage({
    image: canvas,
    width: 64,
    height: 64,
    strokes: [
      { points: [] },
      { points: [{ x: 0.25, y: 0.25 }] },
      {
        points: [
          { x: 0.25, y: 0.75 },
          { x: 0.75, y: 0.75 },
        ],
      },
    ],
  });
  await image.decode();
  drawing.drawImage(image, 0, 0);

  expect([...drawing.getImageData(16, 16, 1, 1).data]).toEqual([224, 68, 45, 255]);
  expect([...drawing.getImageData(32, 48, 1, 1).data]).toEqual([224, 68, 45, 255]);
  expect([...drawing.getImageData(48, 16, 1, 1).data]).toEqual([255, 255, 255, 255]);
});
