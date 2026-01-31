import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: 'src/index.ts',
    platform: 'node',
  },
  {
    entry: 'src/entry.ts',
    platform: 'node',
  },
])
