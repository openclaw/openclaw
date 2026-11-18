import type { Virtualizer } from "@tanstack/virtual-core";
import type { TranscriptRow } from "./chat-transcript-layout.ts";

type TranscriptForecast = { top: number; direction: number; wholeViewport: boolean };

export function pendingWheelDelta(wheel: { delta: number; time: number } | undefined): number {
  // Native scrollTop rounds wheel travel; residue must not hide the observed next step.
  return wheel && performance.now() - wheel.time < 100 && Math.abs(wheel.delta) > 1
    ? wheel.delta
    : 0;
}

export function viewport(
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  delta: number,
  wholeViewport: boolean,
): TranscriptForecast {
  let top = Math.max(0, (virtualizer.scrollOffset ?? 0) + delta);
  if (wholeViewport) {
    const height = virtualizer.scrollRect?.height ?? 600;
    top = Math.min(top, Math.max(0, virtualizer.getTotalSize() - height));
  }
  return { top, direction: Math.sign(delta), wholeViewport };
}

export function indexes(
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  forecast: TranscriptForecast | undefined,
  range: { startIndex: number; endIndex: number },
  mounted: ReadonlySet<number>,
  rows: readonly TranscriptRow[],
  prepareRowLimit: number,
): number[] {
  if (!forecast) {
    return [];
  }
  const height = virtualizer.scrollRect?.height ?? 600;
  // Measurement latency can span several inputs. Multiplying it by velocity
  // skips the arriving viewport and evicts rows that are still approaching.
  const { top, direction } = forecast;
  const first = virtualizer.getVirtualItemForOffset(top);
  const last = virtualizer.getVirtualItemForOffset(top + height);
  if (!first || !last) {
    return [];
  }
  // Wheel input can arrive after native scrolling. Cover its destination within
  // the existing allowance even after consumption; other movement prepares one row.
  const result: number[] = [];
  const limit = forecast.wholeViewport ? prepareRowLimit : 1;
  const endIndex =
    forecast.wholeViewport && last.start >= top + height ? last.index - 1 : last.index;
  for (
    let index = direction < 0 ? endIndex : first.index;
    index >= first.index && index <= endIndex;
    index += direction
  ) {
    if (
      (direction < 0 ? index < range.startIndex : index > range.endIndex) &&
      !mounted.has(index) &&
      rows[index]?.retainDom
    ) {
      result.push(index);
      if (result.length === limit) {
        break;
      }
    }
  }
  return result;
}

export function rowKeys(
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  forecast: TranscriptForecast | undefined,
  rows: readonly TranscriptRow[],
  preparedRowKeys: ReadonlySet<string>,
): Set<string> {
  const keys = new Set<string>();
  if (forecast && virtualizer.range) {
    const { direction, top: next } = forecast;
    const top = virtualizer.scrollOffset ?? 0;
    const height = virtualizer.scrollRect?.height ?? 600;
    // Previous forecasts bridge the gap to the next viewport. Retaining their
    // DOM preserves reversals, but only these two viewports need live layout.
    for (const item of virtualizer.getVirtualItems()) {
      const key = rows[item.index]!.key;
      const approaching =
        direction < 0
          ? item.index < virtualizer.range.startIndex
          : item.index > virtualizer.range.endIndex;
      const coversViewport =
        (item.end > top && item.start < top + height) ||
        (item.end > next && item.start < next + height);
      if (approaching && coversViewport && preparedRowKeys.has(key)) {
        keys.add(key);
      }
    }
  }
  return keys;
}

export function retainedKeys(
  preparedRowKeys: ReadonlySet<string>,
  rowIndexes: ReadonlyMap<string, number>,
  rowCount: number,
  range: { startIndex: number; endIndex: number },
  delta: number,
): string[] {
  const keys = [...preparedRowKeys];
  keys.reverse();
  const direction = Math.sign(delta);
  if (direction) {
    const edge = direction < 0 ? range.startIndex : range.endIndex;
    const rank = (key: string) => {
      const ahead = direction * (rowIndexes.get(key)! - edge);
      return ahead > 0 ? ahead : rowCount;
    };
    keys.sort((left, right) => rank(left) - rank(right));
  }
  return keys;
}

export function preparation(
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  range: { startIndex: number; endIndex: number },
  direction: number,
  distance: number,
) {
  const height = virtualizer.scrollRect?.height ?? 600;
  // At speed, prepare the next viewport rather than rows the reader skips.
  // Virtual-core resolves this from cached sizes; no neighbor layout reads.
  const predictedTop = Math.max(
    0,
    Math.min(
      (virtualizer.scrollOffset ?? 0) + direction * distance,
      Math.max(0, virtualizer.getTotalSize() - height),
    ),
  );
  const predictedOffset = predictedTop + (direction < 0 ? height : 0);
  const predicted = virtualizer.getVirtualItemForOffset(Math.max(0, predictedOffset));
  // Ordinary rows mount with overscan. Warm those neighbours as well as
  // the viewport so its first frame does not parse the cold edge rows.
  const overscan = distance ? virtualizer.options.overscan : 0;
  const origin =
    distance && predicted
      ? predicted.index - direction * (1 + overscan)
      : direction > 0
        ? range.endIndex
        : range.startIndex;
  return { predictedTop, predicted, overscan, origin };
}
