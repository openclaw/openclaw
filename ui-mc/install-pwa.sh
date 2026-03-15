#!/bin/bash
# Install PWA plugin for Mavis MC

echo "Installing vite-plugin-pwa..."
export PATH="/Users/mac/.nvm/versions/node/v22.22.1/bin:$PATH"

# Create a simple package to install
cat > /tmp/install-pwa.js << 'EOF'
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const uiMcPath = '/Users/mac/Documents/Builds/OpenClaw/openclaw/ui-mc';

// Read current package.json
const packageJson = JSON.parse(fs.readFileSync(path.join(uiMcPath, 'package.json'), 'utf8'));

// Add vite-plugin-pwa to devDependencies
packageJson.devDependencies = packageJson.devDependencies || {};
packageJson.devDependencies['vite-plugin-pwa'] = '^0.21.2';

// Write back
fs.writeFileSync(
  path.join(uiMcPath, 'package.json'),
  JSON.stringify(packageJson, null, 2)
);

console.log('Updated package.json with vite-plugin-pwa');

// Install
process.chdir(uiMcPath);
execSync('pnpm install', { stdio: 'inherit' });

console.log('PWA plugin installed successfully!');
EOF

node /tmp/install-pwa.js