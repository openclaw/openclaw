export function createMediaQueryList(media: string, matches: boolean): MediaQueryList {
  return {
    media,
    matches,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  };
}
