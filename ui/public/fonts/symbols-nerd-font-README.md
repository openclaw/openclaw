# Symbols Nerd Font Mono

Source: SymbolsNerdFontMono-Regular.ttf from Nerd Fonts v3.4.0:
https://github.com/ryanoasis/nerd-fonts/tree/v3.4.0/patched-fonts/NerdFontsSymbolsOnly

The upstream MIT license is included in symbols-nerd-font-LICENSE.txt.
This monospace symbols-only variant is intended as a fallback for unpatched
text fonts. All 10,410 mapped glyphs are preserved; no subsetting or patching.

Lossless web packaging: FontTools 4.66.1 with Brotli 1.2.0, Python:

```python
from fontTools.ttLib import TTFont
font = TTFont("SymbolsNerdFontMono-Regular.ttf")
font.flavor = "woff2"
font.save("symbols-nerd-font-mono.woff2")
```

Source TTF SHA-256:
f0f624d9b474bea1662cf7e862d44aebe1ae1f6c7f9cb7a0ca5d0e5ac9561c60

Bundled WOFF2 SHA-256 (1,178,136 bytes):
48ecd4d82b72a87bb7642e45e7b64cd369d52e3eb9eaf39c44154c960286319d

Loaded only when a terminal opens, from the Gateway under the same-origin
font policy. Text uses the existing bundled JetBrains Mono face (see
jetbrains-mono-OFL.txt), or a browser-local user-selected font. No external
font requests or font enumeration are used.
