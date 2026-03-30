import type { SharedType } from "fixture-sdk";
import { sharedThing } from "fixture-sdk";

export function betaUse(input: SharedType) {
	return `${sharedThing()}:${input.value}`;
}
