import { expect, it } from "vitest";
import { encodeSqliteAuthTransferFrame } from "./sqlite-readonly-auth-transfer.js";

it.each([Uint8Array.from([91, 0, 127, 255, 93]), Buffer.from([91, 0, 127, 255, 93])])(
  "encodes only the frame's byte range into an independent string",
  (backing) => {
    const encoded = encodeSqliteAuthTransferFrame({
      id: 1,
      sequence: 0,
      done: false,
      kind: "store",
      recordBytes: 3,
      offset: 0,
      recordDone: true,
      bytes: backing.subarray(1, 4),
    });
    expect(encoded).toMatchObject({ bytes: "AH//" });
    expect([...backing]).toEqual([91, 0, 127, 255, 93]);
    backing.fill(42);
    expect(encoded).toMatchObject({ bytes: "AH//" });
  },
);
