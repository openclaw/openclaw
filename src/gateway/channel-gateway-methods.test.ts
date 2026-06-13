import { describe, expect, it } from "vitest";
import {
  channelGatewayMethodNamesInclude,
  listChannelGatewayMethodNames,
} from "./channel-gateway-methods.js";

describe("channel gateway method projection", () => {
  it("keeps legacy names and descriptor names in registration order", () => {
    expect(
      listChannelGatewayMethodNames({
        gatewayMethods: ["legacy.start"],
        gatewayMethodDescriptors: [{ name: "descriptor.wait" }],
      }),
    ).toEqual(["legacy.start", "descriptor.wait"]);
  });

  it("ignores unreadable channel gateway descriptors", () => {
    const unreadableDescriptor = Object.defineProperty({}, "name", {
      get() {
        throw new Error("channel gateway descriptor name getter exploded");
      },
    });

    expect(
      listChannelGatewayMethodNames({
        gatewayMethods: ["legacy.start"],
        gatewayMethodDescriptors: [unreadableDescriptor, { name: "descriptor.wait" }],
      }),
    ).toEqual(["legacy.start", "descriptor.wait"]);
  });

  it("treats unreadable method arrays as absent", () => {
    const plugin = Object.defineProperty({}, "gatewayMethodDescriptors", {
      get() {
        throw new Error("channel gateway descriptors getter exploded");
      },
    });

    expect(listChannelGatewayMethodNames(plugin)).toEqual([]);
  });

  it("matches readable names without throwing on unreadable descriptors", () => {
    const unreadableDescriptor = Object.defineProperty({}, "name", {
      get() {
        throw new Error("channel gateway descriptor name getter exploded");
      },
    });

    expect(
      channelGatewayMethodNamesInclude(
        {
          gatewayMethodDescriptors: [unreadableDescriptor, { name: "web.login.start" }],
        },
        new Set(["web.login.start"]),
      ),
    ).toBe(true);
  });
});
