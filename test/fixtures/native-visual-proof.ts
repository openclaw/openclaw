// A complete 200x200 RGB PNG; synthetic pixels contain no operator data.
export const nativeVisualProofPNG =
  "iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAIAAAAiOjnJAAACEElEQVR4nO3SQQkAMAzAwPo3vaoIg3KnII/Mg8D8DuAmY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBaJBcLKBp7i8n+mAAAAAElFTkSuQmCC";

export const nativeVisualProofTrailingPayload = "synthetic-private-trailing-payload";

// Compare decoded RGBA pixels rather than compressed bytes or encoder metadata.
export const nativeVisualProofPixelCheck = `
import Foundation
import ImageIO
func pixels(_ data: Data) -> Data {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
          image.width == 200, image.height == 200,
          let context = CGContext(data: nil, width: 200, height: 200, bitsPerComponent: 8,
                                  bytesPerRow: 800, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
          let bytes = context.data
    else { exit(1) }
    context.draw(image, in: CGRect(x: 0, y: 0, width: 200, height: 200))
    return Data(bytes: bytes, count: 160000)
}
let expected = pixels(Data(base64Encoded: "${nativeVisualProofPNG}")!)
guard CommandLine.arguments.count > 1 else { exit(1) }
for file in CommandLine.arguments.dropFirst() {
    guard pixels(try Data(contentsOf: URL(fileURLWithPath: file))) == expected else { exit(1) }
}
`;
