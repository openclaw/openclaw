# Lego AI Generation Pipeline

## Overview
This module outlines the architecture for generating 3D Lego models from images or text prompts using AI, converting them into LDraw format, and optimizing them for physical assembly.

## Pipeline Steps

### 1. Image/Prompt to 3D Voxel
- Use Generative 3D models (e.g., Point-E, Shap-E) to create a coarse voxel representation of the target object.

### 2. Voxel to Brick
- **Algorithm**: Map voxels to available Lego brick geometries.
- **Optimization**: Use constraint solving (CSP) to minimize brick count and ensure structural integrity (connectivity analysis).
- **SNOT Techniques**: "Studs Not On Top" - allow brick placement in multiple orientations for higher detail.

### 3. LDraw Generation
- Convert the optimized brick layout into the LDraw standard file format (.ldr / .mpd).
- Assign correct color codes and part IDs from the LDraw library.

### 4. Instruction Generation
- Analyze the dependency graph of the assembly.
- Generate step-by-step instructions, grouping parts logically.
- Render isometric views for each step using a raytracer.

## Resources
- **LDraw Standard**: https://www.ldraw.org/
- **BrickUtils**: Python libraries for geometry mapping.
